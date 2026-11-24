// Owns the Socket.IO server instance so feature modules can push realtime
// events without importing the websocket layer (avoids circular imports).
//
// Room naming is centralised here; see docs/contracts/*.md for the events.

let ioRef = null;

export const rooms = Object.freeze({
    user: (userId) => `user:${String(userId)}`,
    role: (role) => `role:${String(role)}`,
    presenter: (sessionId) => `attendance:presenter:${String(sessionId)}`,
});

export const setIO = (io) => {
    ioRef = io;
};

export const getIO = () => ioRef;

export const emitToRoom = (room, event, payload) => {
    if (!ioRef || !room) return false;
    ioRef.to(room).emit(event, payload);
    return true;
};

export const emitToUser = (userId, event, payload) => {
    if (!userId) return false;
    return emitToRoom(rooms.user(userId), event, payload);
};

export const emitToUsers = (userIds, event, payload) => {
    if (!ioRef || !Array.isArray(userIds) || userIds.length === 0) return false;
    const unique = [...new Set(userIds.filter(Boolean).map(String))];
    if (unique.length === 0) return false;
    ioRef.to(unique.map((id) => rooms.user(id))).emit(event, payload);
    return true;
};

export const emitToRole = (role, event, payload) => emitToRoom(rooms.role(role), event, payload);
