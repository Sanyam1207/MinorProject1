// Starting a class: capture the teacher's location when the course checks
// students' location (settings.requireGeo), or when the server answers
// LOCATION_REQUIRED, then POST /sessions/:id/start.
import { useState } from "react";
import { startSession } from "../../../lib/api/attendance.js";

export class GeoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GeoError";
    this.code = code;
  }
}

/** navigator.geolocation as a promise → `{ lat, lng, accuracy }`. */
export const requestGeo = ({ timeoutMs = 15000 } = {}) =>
  new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new GeoError("GEO_UNAVAILABLE", "This browser can't share your location."));
      return;
    }
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      reject(new GeoError("GEO_INSECURE", "Location needs a secure (https) connection. Open the app over https to start this class."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (error) => {
        const denied = error?.code === 1;
        reject(
          new GeoError(
            denied ? "GEO_DENIED" : "GEO_FAILED",
            denied
              ? "Location access was blocked. This course checks students' location — allow location for this site and try again."
              : "Couldn't get your location. Move near a window or turn on location services and try again.",
          ),
        );
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });

/**
 * Start a session. `requireGeo` (from course.settings) asks for the location
 * first; otherwise a LOCATION_REQUIRED answer triggers one retry with it.
 * Resolves `{ session, qr, alreadyLive }`.
 */
export const startWithGeo = async (sessionId, { requireGeo = false } = {}) => {
  let geo = requireGeo ? await requestGeo() : undefined;
  try {
    return await startSession(sessionId, { geo });
  } catch (error) {
    if (error?.code !== "LOCATION_REQUIRED" || geo) throw error;
    geo = await requestGeo();
    return startSession(sessionId, { geo });
  }
};

/** `{ start(sessionId, {requireGeo}), startingId }` — tracks which session is being started. */
export function useStartSession() {
  const [startingId, setStartingId] = useState(null);
  const start = async (sessionId, options) => {
    setStartingId(sessionId);
    try {
      return await startWithGeo(sessionId, options);
    } finally {
      setStartingId(null);
    }
  };
  return { start, startingId };
}
