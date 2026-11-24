// The sources a sync polls, evaluated per sync so a changed FROM_ARTHA / ARTHA_*
// setting applies to the next run (docs/contracts/JOB-FEED.md §4).
import { getJobFeedConfig } from "../config.js";
import { ArthaJobSource } from "./artha.source.js";
import { DebugWithShubhamJobSource } from "./debug-with-shubham.source.js";

export const getPolledSources = (config = getJobFeedConfig()) => [
    new DebugWithShubhamJobSource(),
    ...(config.fromArtha
        ? [new ArthaJobSource({ keywords: config.arthaKeywords, location: config.arthaLocation, countries: config.arthaCountries })]
        : []),
];

export { ArthaJobSource, DebugWithShubhamJobSource };
