// Fuzzy references for the copilot tools (AGENT-TOOLS.md §5): courses by id,
// code or name ("dbms", "CS301", "computer networks"), sessions by id, course
// and/or date ("tomorrow 10am"), students by id, email, enrolment/roll number or name.
// Several equally good matches raise AmbiguousReference, which the tools turn
// into `{ambiguous:true, message, candidates}`.
import { fail, isObjectId } from "../../core/http.js";
import { User } from "../../models/user.models.js";
import { assertCanManageSession, assertCanReportSession, isOversight, loadSession } from "./access.js";
import { AttendanceRecord, ClassSession, Course } from "./models/index.js";
import { idString } from "./serializers.js";
import { formatDay, formatSlot, formatTime, parseDateInput, parseWhen } from "./time.js";

export class AmbiguousReference extends Error {
    constructor(message, candidates) {
        super(message);
        this.name = "AmbiguousReference";
        this.candidates = candidates;
    }
}

const MAX_CANDIDATES = 10;
const FILLER = new Set([
    "the", "my", "our", "a", "an", "class", "classes", "lecture", "lectures", "course", "courses", "session", "sessions",
    "period", "next", "upcoming", "todays", "today's", "tomorrows", "this", "that", "for", "of", "in", "on", "at", "subject",
]);
const NAME_STOPWORDS = new Set(["of", "and", "the", "in", "to", "for", "a", "an", "with", "on"]);

export const normalise = (value) => String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const stripFiller = (value) => normalise(value).split(" ").filter((word) => word && !FILLER.has(word)).join(" ");

/** Does `query` spell initials of consecutive-or-skipped words, optionally with extra letters of each word? ("dbms") */
const matchesAcronym = (query, words) => {
    const solve = (qi, wi, matchedWords) => {
        if (qi === query.length) return matchedWords >= 2;
        if (wi >= words.length) return false;
        const word = words[wi];
        if (word[0] === query[qi]) {
            // take this word's initial, then optionally more letters of the same word (in order)
            let q = qi + 1;
            if (solve(q, wi + 1, matchedWords + 1)) return true;
            for (let ci = 1; ci < word.length && q < query.length; ci += 1) {
                if (word[ci] === query[q]) {
                    q += 1;
                    if (solve(q, wi + 1, matchedWords + 1)) return true;
                }
            }
        }
        // a word may be skipped, but never the first one
        return wi > 0 && solve(qi, wi + 1, matchedWords);
    };
    return query.length >= 2 && words.length >= 2 && solve(0, 0, 0);
};

/** 0 (no match) … 100 (exact code). */
export const scoreCourse = (query, course) => {
    const q = stripFiller(query);
    const qc = q.replace(/ /g, "");
    if (!qc) return 0;
    const code = normalise(course.code).replace(/ /g, "");
    const name = normalise(course.name);
    const nameCompact = name.replace(/ /g, "");
    const words = name.split(" ").filter((word) => word && !NAME_STOPWORDS.has(word));
    const initials = words.map((word) => word[0]).join("");
    const section = normalise(course.section);
    if (qc === code) return 100;
    if (section && (qc === `${code}${section}` || qc === `${code}section${section}`)) return 100;
    if (qc === nameCompact) return 95;
    if (initials.length >= 2 && qc === initials) return 90;
    if (code.length >= 3 && qc.includes(code)) return 85;
    if (qc.length >= 3 && code.startsWith(qc)) return 80;
    if (qc.length >= 3 && nameCompact.includes(qc)) return 75;
    const tokens = q.split(" ").filter(Boolean);
    if (tokens.length && tokens.every((token) => words.some((word) => word.startsWith(token)))) return 65;
    if (matchesAcronym(qc, words)) return 55;
    return 0;
};

export const courseLabel = (course) => {
    const extra = [course.section && `section ${course.section}`, course.academicYear].filter(Boolean).join(", ");
    return `${course.code} · ${course.name}${extra ? ` (${extra})` : ""}`;
};

const courseScope = (user) => {
    if (user.role === "teacher") return { teacher: user._id };
    if (user.role === "student") return { students: user._id };
    if (isOversight(user)) return {};
    throw fail(403, "Attendance is available to teachers, students and the placement office", "FORBIDDEN");
};

const ambiguousCourses = (courses, message) => new AmbiguousReference(
    message,
    courses.slice(0, MAX_CANDIDATES).map((course) => ({ id: idString(course._id), label: courseLabel(course), code: course.code })),
);

/**
 * @param {string|undefined} ref id, code or name
 * @param {{user}} ctx
 * @param {{required?: boolean, includeArchived?: boolean}} options
 *   required=false: a missing ref resolves to the caller's only course, or null
 * @returns {Promise<object|null>} lean course
 */
export const resolveCourse = async (ref, ctx, { required = true, includeArchived = false } = {}) => {
    const user = ctx.user;
    const scope = { ...courseScope(user), ...(includeArchived ? {} : { status: "active" }) };
    const text = typeof ref === "string" ? ref.trim() : ref ? String(ref) : "";
    if (text && isObjectId(text)) {
        const course = await Course.findOne({ _id: text, ...scope }).lean();
        if (!course) throw fail(404, "No such course among yours", "NOT_FOUND");
        return course;
    }
    if (!text || !stripFiller(text)) {
        if (!required) return null;
        const courses = await Course.find(scope).sort({ code: 1 }).limit(50).lean();
        if (courses.length === 1) return courses[0];
        if (!courses.length) throw fail(404, "You have no attendance courses yet", "NOT_FOUND");
        throw ambiguousCourses(courses, "Which course do you mean?");
    }
    const courses = await Course.find(scope).lean();
    let best = 0;
    let top = [];
    for (const course of courses) {
        const score = scoreCourse(text, course);
        if (score > best) {
            best = score;
            top = [course];
        } else if (score === best && score > 0) top.push(course);
    }
    if (!best) {
        const known = courses.slice(0, 8).map((course) => course.code).join(", ");
        throw fail(404, `No course matches "${text.slice(0, 60)}"${known ? ` (yours: ${known})` : ""}`, "NOT_FOUND");
    }
    if (top.length === 1) return top[0];
    throw ambiguousCourses(top, `Several courses match "${text.slice(0, 60)}". Which one?`);
};

export const sessionLabel = (session, course) => {
    const code = course?.code || session.course?.code || "Class";
    return `${code} · ${formatSlot(session.startsAt, session.endsAt)} (${session.status})${session.topic ? ` — ${session.topic}` : ""}`;
};

const sessionScope = (user) => {
    if (user.role === "teacher") return { teacher: user._id };
    if (isOversight(user)) return {};
    throw fail(403, "Only teachers and the placement office manage class sessions", "FORBIDDEN");
};

/**
 * Find one session from `{session, course, <dateField>}`.
 * @param {object} args tool args
 * @param {{user, now}} ctx
 * @param {{statuses: string[], order?: "next"|"recent", liveFirst?: boolean, dateField?: string,
 *          access?: "manage"|"report", forward?: boolean, describe?: string}} options
 * @returns {Promise<{session, course}>} mongoose docs
 */
export const resolveSession = async (args, ctx, {
    statuses,
    order = "next",
    liveFirst = false,
    dateField = "when",
    access = "manage",
    forward = true,
    describe = "class",
} = {}) => {
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const check = (loaded) => {
        if (access === "manage") assertCanManageSession(ctx.user, loaded.session, loaded.course);
        else assertCanReportSession(ctx.user, loaded.session, loaded.course);
        return loaded;
    };
    const ref = typeof args.session === "string" ? args.session.trim() : "";
    if (ref && isObjectId(ref)) return check(await loadSession(ref));

    let courseText = typeof args.course === "string" ? args.course.trim() : "";
    let dateText = typeof args[dateField] === "string" ? args[dateField].trim() : "";
    if (ref) {
        // Free text such as "dbms tomorrow 10am": split the date from the course words.
        const parsed = parseWhen(ref, { now, forward });
        if (parsed) {
            if (!dateText) dateText = parsed.text;
            if (!courseText) courseText = ref.replace(parsed.text, " ").trim();
        } else if (!courseText) courseText = ref;
    }
    const course = courseText && stripFiller(courseText) ? await resolveCourse(courseText, ctx, { includeArchived: true }) : null;
    const when = dateText ? parseDateInput(dateText, { field: dateField, now, forward }) : null;

    const filter = { ...sessionScope(ctx.user), status: { $in: statuses } };
    if (course) filter.course = course._id;
    if (when?.hasTime) filter.startsAt = { $gte: new Date(when.date.getTime() - 3 * 3_600_000), $lte: new Date(when.date.getTime() + 3 * 3_600_000) };
    else if (when) filter.startsAt = { $gte: when.dayStart, $lte: when.dayEnd };
    else if (order === "next") filter.endsAt = { $gt: liveFirst ? new Date(now.getTime() - 12 * 3_600_000) : now };
    else filter.startsAt = { $lte: new Date(now.getTime() + 60 * 60_000) };

    let sessions = await ClassSession.find(filter)
        .populate("course", "code name section academicYear")
        .sort({ startsAt: order === "next" ? 1 : -1 })
        .limit(25)
        .lean();
    if (when?.hasTime) {
        sessions.sort((a, b) => Math.abs(a.startsAt - when.date) - Math.abs(b.startsAt - when.date));
    }
    if (liveFirst) sessions = [...sessions.filter((s) => s.status === "live"), ...sessions.filter((s) => s.status !== "live")];
    if (!sessions.length) {
        const parts = [course ? course.code : null, when ? `${formatDay(when.date)}${when.hasTime ? ` ${formatTime(when.date)}` : ""}` : null].filter(Boolean);
        throw fail(404, `No ${statuses.join("/")} ${describe} found${parts.length ? ` for ${parts.join(" on ")}` : ""}`, "NOT_FOUND");
    }
    const dayOnly = when && !when.hasTime;
    const sameDayChoices = dayOnly && sessions.length > 1 && !(liveFirst && sessions[0].status === "live" && sessions[1].status !== "live");
    if (sameDayChoices) {
        throw new AmbiguousReference(
            `Several ${describe}es match. Which one?`,
            sessions.slice(0, MAX_CANDIDATES).map((session) => ({ id: idString(session._id), label: sessionLabel(session), course: session.course?.code })),
        );
    }
    return check(await loadSession(sessions[0]._id));
};

const STUDENT_FIELDS = "name email ggsipuEnrollment rollNumber branch section";

export const studentLabel = (student) => {
    const id = student.ggsipuEnrollment || student.rollNumber;
    return `${student.name}${id ? ` (${id})` : ""} — ${student.email}`;
};

/** A student of `course` (or with a record in `session`) by id, email, enrolment/roll number or name. */
export const resolveStudent = async (ref, course, session = null) => {
    const text = String(ref ?? "").trim();
    if (!text) throw fail(400, "Name the student", "VALIDATION", { field: "student" });
    const ids = new Set((course.students || []).map(String));
    if (session) {
        for (const id of await AttendanceRecord.find({ session: session._id }).distinct("student")) ids.add(String(id));
    }
    if (isObjectId(text)) {
        if (!ids.has(text)) throw fail(403, `That student is not enrolled in ${course.code}`, "NOT_ENROLLED");
        const student = await User.findById(text).select(STUDENT_FIELDS).lean();
        if (!student) throw fail(404, "Student not found", "NOT_FOUND");
        return student;
    }
    const students = await User.find({ _id: { $in: [...ids] } }).select(STUDENT_FIELDS).lean();
    const lower = text.toLowerCase();
    const exact = students.filter((student) => [student.email, student.ggsipuEnrollment, student.rollNumber]
        .some((value) => value && String(value).toLowerCase() === lower));
    if (exact.length === 1) return exact[0];
    const query = normalise(text);
    const byName = students.filter((student) => normalise(student.name) === query);
    if (byName.length === 1) return byName[0];
    const tokens = query.split(" ").filter(Boolean);
    const partial = byName.length ? byName : students.filter((student) => {
        const words = normalise(student.name).split(" ");
        return tokens.length > 0 && tokens.every((token) => words.some((word) => word.startsWith(token)));
    });
    if (partial.length === 1) return partial[0];
    if (!partial.length) {
        const outside = await User.findOne({
            $or: [{ email: lower }, { ggsipuEnrollment: text }, { rollNumber: text }],
        }).select("name").lean();
        if (outside) throw fail(403, `${outside.name} is not enrolled in ${course.code}`, "NOT_ENROLLED");
        throw fail(404, `No student in ${course.code} matches "${text.slice(0, 60)}"`, "NOT_FOUND");
    }
    throw new AmbiguousReference(
        `Several students in ${course.code} match "${text.slice(0, 60)}". Which one?`,
        partial.slice(0, MAX_CANDIDATES).map((student) => ({ id: idString(student._id), label: studentLabel(student), email: student.email })),
    );
};

