import { Elective } from "../models/elective.models.js";

/**
 * Fetch all electives with name, upvote count (calculated), and topics.
 * Uses an aggregation pipeline to compute the upvotedBy array size.
 * @returns {Promise<Array<{ name: string, upvoteCount: number, topics: string[] }>>}
 */
export const fetchElectivesWithUpvotes = async () => {
    return Elective.aggregate([
        {
            $project: {
                _id: 0,
                name: 1,
                upvoteCount: { $size: "$upvotedBy" },
                topics: 1,
            },
        },
        { $sort: { upvoteCount: -1 } },
    ]);
};
