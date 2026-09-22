import { z } from "zod";

export const MatchActionSchema = z.object({
  userAction: z.enum(["none", "saved", "dismissed"]),
});
export type MatchAction = z.infer<typeof MatchActionSchema>;
