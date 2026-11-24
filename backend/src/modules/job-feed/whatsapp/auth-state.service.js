// Baileys' useMultiFileAuthState, stored in MongoDB and encrypted at rest
// (docs/contracts/JOB-FEED.md §2.4, §11.2). Hosts that wipe the disk on restart
// would otherwise need the phone linked again after every deploy. The library is
// passed in (`lib.BufferJSON`, `lib.initAuthCreds`, `lib.proto`).
import { decrypt, encrypt } from "../../../utils/crypto.js";
import { WhatsAppAuthState } from "../models/whatsapp-auth-state.model.js";

export const UNDECRYPTABLE_LOGIN_MESSAGE =
    "The saved WhatsApp login could not be decrypted (TOKEN_ENCRYPTION_KEY changed?); link the device again.";

let undecryptableReported = false;

/** True when TOKEN_ENCRYPTION_KEY can encrypt (64 hex characters). */
export const canEncryptAuthState = () => {
    try {
        return decrypt(encrypt("probe")) === "probe";
    } catch {
        return false;
    }
};

export async function useMongoAuthState(lib, { log = console } = {}) {
    const { BufferJSON, initAuthCreds, proto } = lib;
    // Writes to one key run in order, like the per-file locks in the file version.
    const pending = new Map();
    const queue = (id, task) => {
        const next = (pending.get(id) ?? Promise.resolve()).then(task, task);
        pending.set(id, next);
        return next;
    };

    const read = async (id) => {
        const doc = await WhatsAppAuthState.findById(id).lean();
        if (!doc) return null;
        try {
            return JSON.parse(decrypt(doc.value), BufferJSON.reviver);
        } catch {
            // A value that cannot be decrypted is treated as missing.
            if (!undecryptableReported) {
                undecryptableReported = true;
                log.warn(`WhatsApp: ${UNDECRYPTABLE_LOGIN_MESSAGE}`);
            }
            return null;
        }
    };
    const write = (id, value) => queue(id, () => WhatsAppAuthState.updateOne(
        { _id: id },
        { $set: { value: encrypt(JSON.stringify(value, BufferJSON.replacer)) } },
        { upsert: true },
    ));
    const remove = (id) => queue(id, () => WhatsAppAuthState.deleteOne({ _id: id }));

    const creds = (await read("creds")) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await read(`${type}-${id}`);
                        if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => write("creds", creds),
    };
}

// Forgets the linked device, so the next start shows a new QR or pairing code.
export async function clearMongoAuthState() {
    await WhatsAppAuthState.deleteMany({});
    undecryptableReported = false;
}
