// Legacy SIH Resume Bank migration (docs/contracts/RESUME-BYOK.md §2.4).
//
// Idempotent: only docs without `kind`, or with `storage` or `latexCode`, are
// touched, so a second run changes nothing. Runs at boot (resume-lab start())
// and from `npm run migrate:resumes`.
import mongoose from "mongoose";
import { Resume } from "../models/resume.model.js";
import { describeText } from "./extract.service.js";

const LEGACY_INDEX = "owner_1_sourceHash_1";

const dropLegacyIndex = async () => {
    try {
        await Resume.collection.dropIndex(LEGACY_INDEX);
        return true;
    } catch (error) {
        // "index not found" (27) / "ns not found" (26) are expected on fresh databases.
        if (error?.code === 27 || error?.code === 26 || /not found|ns does not exist/i.test(error?.message || "")) return false;
        throw error;
    }
};

const shareCollection = () => mongoose.models.MentorshipMessage?.collection
    ?? mongoose.connection.collection("mentorshipmessages");

const earliestShare = async (resumeId) => {
    const [share] = await shareCollection()
        .find({ type: "resume-share", resumeVersion: resumeId })
        .sort({ createdAt: 1 })
        .limit(1)
        .project({ createdAt: 1 })
        .toArray();
    return share ? (share.createdAt || new Date()) : null;
};

const legacyPdf = (storage, sourceHash, createdAt) => {
    if (!storage || typeof storage !== "object" || !storage.publicId) return null;
    return {
        driver: "cloudinary",
        key: String(storage.publicId),
        contentType: "application/pdf",
        bytes: Number(storage.bytes) || 0,
        meta: {
            resourceType: storage.resourceType || "image",
            deliveryType: storage.deliveryType || "authenticated",
            format: storage.format || "pdf",
            assetId: storage.assetId || "",
        },
        sourceHash,
        compiledAt: createdAt || new Date(),
    };
};

/**
 * Migrate legacy SIH resume documents in place.
 * @returns {Promise<{migrated: number, locked: number, primaries: number}>}
 */
export const migrateLegacyResumes = async ({ log = true } = {}) => {
    const collection = Resume.collection;
    // Drop the legacy unique {owner, sourceHash} index FIRST: recomputed hashes of
    // two legacy versions with the same source would otherwise collide.
    await dropLegacyIndex();

    const filter = { $or: [{ kind: { $exists: false } }, { storage: { $exists: true } }, { latexCode: { $exists: true } }] };
    const owners = new Set();
    let migrated = 0;
    let locked = 0;

    for await (const doc of collection.find(filter)) {
        const set = {};
        const unset = {};
        const isLegacy = !doc.kind;
        const rawSource = typeof doc.source === "string" ? doc.source : typeof doc.latexCode === "string" ? doc.latexCode : null;
        let sourceHash = doc.sourceHash;

        if (typeof doc.latexCode === "string") unset.latexCode = "";
        if (isLegacy || typeof doc.latexCode === "string") {
            const source = String(rawSource ?? "").replace(/\r\n?/g, "\n");
            const described = describeText(source, { kind: "latex" });
            sourceHash = described.sha256;
            Object.assign(set, {
                kind: "latex",
                source,
                sourceBytes: Buffer.byteLength(source, "utf8"),
                sourceHash,
                extractedText: described.extractedText,
                meta: described.meta,
            });
            if (isLegacy) {
                Object.assign(set, { origin: "generated", revision: 1, isPrimary: false });
                if (!doc.dedupeKey && typeof doc.sourceHash === "string") set.dedupeKey = doc.sourceHash;
                if (!doc.status) set.status = "active";
            }
        }
        if (doc.storage !== undefined) {
            const pdf = legacyPdf(doc.storage, sourceHash, doc.createdAt);
            if (pdf && !doc.pdf) set.pdf = pdf;
            unset.storage = "";
        }
        if (!doc.lockedAt) {
            const sharedAt = await earliestShare(doc._id);
            if (sharedAt) {
                set.lockedAt = sharedAt;
                set.lockReasons = [...new Set([...(Array.isArray(doc.lockReasons) ? doc.lockReasons : []), "alumni-share"])];
                locked += 1;
            }
        }

        const update = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        if (!Object.keys(update).length) continue;
        await collection.updateOne({ _id: doc._id }, update);
        migrated += 1;
        if (doc.owner) owners.add(String(doc.owner));
    }

    let primaries = 0;
    for (const owner of owners) {
        const ownerId = new mongoose.Types.ObjectId(owner);
        if (await collection.findOne({ owner: ownerId, isPrimary: true, status: "active" }, { projection: { _id: 1 } })) continue;
        await collection.updateMany({ owner: ownerId, isPrimary: true }, { $set: { isPrimary: false } });
        const [candidate] = await collection.find({ owner: ownerId, status: "active" })
            .sort({ version: -1 }).limit(1).project({ _id: 1 }).toArray();
        if (!candidate) continue;
        await collection.updateOne({ _id: candidate._id }, { $set: { isPrimary: true } });
        primaries += 1;
    }

    await dropLegacyIndex();
    await Resume.syncIndexes();
    if (log && (migrated || primaries)) {
        console.log(`[resume-lab] legacy resume migration: ${JSON.stringify({ migrated, locked, primaries })}`);
    }
    return { migrated, locked, primaries };
};
