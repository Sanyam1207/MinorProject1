// Reads posts from WhatsApp channels as a linked device (docs/contracts/JOB-FEED.md §11).
// Ported from Matchy's whatsapp-channel.source.js. The Baileys library is passed
// in (`lib`, from whatsapp/baileys.js) — this file never imports it.
// Never sends messages or read receipts and stays "offline".
import { clearMongoAuthState, useMongoAuthState } from "./auth-state.service.js";
import { makeSocketFactory } from "./baileys.js";

const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
// Only fresh posts become jobs, so a reconnect cannot flood the list with old posts.
export const MAX_POST_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const FOLLOWING_ROLES = new Set(["SUBSCRIBER", "ADMIN", "OWNER"]);

// Baileys logs a lot. The listener prints its own short messages instead.
const quietLogger = {
    level: "silent",
    child: () => quietLogger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
};

function channelName(metadata) {
    return metadata?.name || metadata?.thread_metadata?.name?.text || null;
}

// Accepts channel links (https://whatsapp.com/channel/<code>), bare invite codes, channel IDs (<digits>@newsletter), or "all".
export function parseChannelList(value) {
    const items = String(value ?? "").split(/[\s,]+/).filter(Boolean);
    if (items.some((item) => item.toLowerCase() === "all")) return { all: true, jids: [], inviteCodes: [], invalid: [] };

    const channels = { all: false, jids: [], inviteCodes: [], invalid: [] };
    for (const item of items) {
        const inviteCode = item.match(/channel\/([A-Za-z0-9_-]+)/)?.[1] ?? (/^[A-Za-z0-9_-]{10,}$/.test(item) ? item : null);
        if (/^\d+@newsletter$/i.test(item)) channels.jids.push(item.toLowerCase());
        else if (inviteCode) channels.inviteCodes.push(inviteCode);
        else channels.invalid.push(item);
    }
    channels.jids = [...new Set(channels.jids)];
    channels.inviteCodes = [...new Set(channels.inviteCodes)];
    return channels;
}

/** A channel post {channelJid, messageId, text, postedAt}, or null for anything else. */
export function toChannelPost(message, lib) {
    const channelJid = message?.key?.remoteJid;
    if (!lib?.isJidNewsletter?.(channelJid) || message.key.fromMe || !message.key.id) return null;

    const content = lib.normalizeMessageContent(message.message);
    const text = content?.conversation
        || content?.extendedTextMessage?.text
        || content?.imageMessage?.caption
        || content?.videoMessage?.caption
        || content?.documentMessage?.caption
        || "";
    if (!text.trim()) return null;

    const seconds = lib.toNumber(message.messageTimestamp ?? 0);
    return {
        channelJid,
        messageId: message.key.id,
        text: text.trim(),
        postedAt: seconds ? new Date(seconds * 1000) : new Date(),
    };
}

export class WhatsAppChannelSource {
    constructor({ lib, channels, pairingNumber, onPost, onFatal, onState = () => {}, log = console }) {
        this.lib = lib;
        this.channels = channels;
        this.pairingNumber = pairingNumber ? String(pairingNumber).replace(/\D/g, "") : null;
        this.onPost = onPost;
        this.onFatal = onFatal;
        this.onState = onState;
        this.log = log;
        this.allowed = new Map();
        this.names = new Map();
        this.resolvedInvites = new Set();
        this.reported = new Set();
        this.version = null;
        this.socket = null;
        this.attempt = 0;
        this.reconnectTimer = null;
        this.stopped = false;
    }

    async start() {
        try {
            await this.connect();
        } catch (error) {
            // A failed first connect (network down) is retried with the usual backoff.
            this.log.error("WhatsApp: could not connect:", error?.message || error);
            this.handleClose(undefined);
        }
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        try {
            this.socket?.end(undefined);
        } catch {
            // Already closed.
        }
    }

    async connect() {
        const makeWASocket = makeSocketFactory(this.lib);
        if (!makeWASocket) throw new Error("The installed baileys package has no makeWASocket export.");
        const { state, saveCreds } = await useMongoAuthState(this.lib, { log: this.log });
        if (!this.version) this.version = (await this.lib.fetchLatestBaileysVersion()).version;

        const socket = makeWASocket({
            version: this.version,
            auth: state,
            logger: quietLogger,
            browser: this.lib.Browsers.appropriate("Chrome"),
            // Staying "offline" keeps notifications working on the phone.
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
        });
        this.socket = socket;
        let pairingRequested = false;

        socket.ev.on("creds.update", saveCreds);
        socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
            try {
                if (qr && !pairingRequested) pairingRequested = await this.showLogin(socket, qr);
                if (connection === "open") await this.handleOpen(socket);
                if (connection === "close" && socket === this.socket) this.handleClose(lastDisconnect);
            } catch (error) {
                this.log.error("WhatsApp:", error.message);
            }
        });
        socket.ev.on("messages.upsert", async ({ messages }) => {
            for (const message of messages) {
                try {
                    await this.receive(socket, message);
                } catch (error) {
                    this.log.error("WhatsApp: could not read a message:", error.message);
                }
            }
        });
    }

    // Returns true once a pairing code was shown, so later QR refreshes are ignored.
    async showLogin(socket, qr) {
        this.onState({ state: "waiting-for-link" });
        if (this.pairingNumber && !socket.authState.creds.registered) {
            const code = await socket.requestPairingCode(this.pairingNumber);
            this.log.log(`\nWhatsApp: on your phone open WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead", then enter ${code}\n`);
            return true;
        }
        const { default: QRCode } = await import("qrcode");
        this.log.log(await QRCode.toString(qr, { type: "terminal", small: true }));
        this.log.log("WhatsApp: scan this QR code on your phone: WhatsApp → Settings → Linked devices → Link a device. A new code appears every few seconds until one is scanned.\n");
        return false;
    }

    async handleOpen(socket) {
        this.attempt = 0;
        this.onState({ state: "connected" });
        this.log.log("WhatsApp: connected.");
        await this.resolveChannels(socket);
    }

    handleClose(lastDisconnect) {
        if (this.stopped) return;
        const { DisconnectReason } = this.lib;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
            clearMongoAuthState()
                .then(() => this.onFatal("WhatsApp logged this device out, so the saved login was removed. Restart the listener to link it again."))
                .catch((error) => this.onFatal(`WhatsApp logged this device out, and the saved login could not be removed: ${error.message}`));
            return;
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
            this.onFatal("Another listener connected with the same WhatsApp login, so this one is stopping.");
            return;
        }
        if (statusCode === DisconnectReason.forbidden) {
            this.onFatal("WhatsApp refused the connection (403). Check the account in the WhatsApp app before trying again.");
            return;
        }

        const restart = statusCode === DisconnectReason.restartRequired;
        const delay = restart ? 0 : RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
        this.attempt += 1;
        this.onState({ state: "reconnecting" });
        if (restart) this.log.log("WhatsApp: linked. Restarting the connection...");
        else this.log.warn(`WhatsApp: connection closed (${statusCode ?? "no status"}). Reconnecting in ${delay / 1000}s...`);
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (this.stopped) return;
            this.connect().catch((error) => {
                this.log.error("WhatsApp: reconnect failed:", error.message);
                this.handleClose(undefined);
            });
        }, delay);
        this.reconnectTimer.unref?.();
    }

    async resolveChannels(socket) {
        if (this.channels.all) {
            this.log.log("WhatsApp: collecting job posts from every channel you follow.");
            return;
        }

        for (const code of this.channels.inviteCodes) {
            if (this.resolvedInvites.has(code)) continue;
            const metadata = await socket.newsletterMetadata("invite", code).catch(() => null);
            if (!metadata?.id) {
                this.log.warn(`WhatsApp: no channel was found for the invite link code ${code}.`);
                continue;
            }
            this.resolvedInvites.add(code);
            this.allowChannel(metadata.id, metadata);
        }
        for (const jid of this.channels.jids) {
            if (!this.allowed.has(jid)) this.allowChannel(jid, await socket.newsletterMetadata("jid", jid).catch(() => null));
        }

        if (this.allowed.size) {
            this.log.log(`WhatsApp: listening to ${this.allowed.size} channel(s): ${[...this.allowed.values()].join(", ")}.`);
        } else if (this.channels.inviteCodes.length || this.channels.jids.length) {
            this.log.warn("WhatsApp: none of the channels in WHATSAPP_CHANNELS could be found yet.");
        } else {
            this.log.log("WhatsApp: no channels are set up yet. Add channel links to WHATSAPP_CHANNELS. Channels that post while this runs are listed below with their IDs.");
        }
    }

    allowChannel(jid, metadata) {
        const name = channelName(metadata) || jid;
        this.allowed.set(jid, name);
        const role = metadata?.viewer_metadata?.role;
        if (role && !FOLLOWING_ROLES.has(role)) {
            this.log.warn(`WhatsApp: you don't follow "${name}". Follow it in WhatsApp, or its posts won't reach the job feed.`);
        }
    }

    async receive(socket, message) {
        const post = toChannelPost(message, this.lib);
        if (!post || Date.now() - post.postedAt.getTime() > MAX_POST_AGE_MS) return;
        if (!this.channels.all && !this.allowed.has(post.channelJid)) {
            await this.reportSkippedChannel(socket, post.channelJid);
            return;
        }
        post.channelName = this.allowed.get(post.channelJid) ?? (await this.lookupName(socket, post.channelJid));
        this.onPost(post);
    }

    async lookupName(socket, jid) {
        if (!this.names.has(jid)) {
            this.names.set(jid, channelName(await socket.newsletterMetadata("jid", jid).catch(() => null)) || jid);
        }
        return this.names.get(jid);
    }

    async reportSkippedChannel(socket, jid) {
        if (this.reported.has(jid)) return;
        this.reported.add(jid);
        this.log.log(`WhatsApp: skipped a post from "${await this.lookupName(socket, jid)}". To collect its jobs, add ${jid} to WHATSAPP_CHANNELS.`);
    }
}
