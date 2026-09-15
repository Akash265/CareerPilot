import { z } from "zod";

export { formatValidationError } from "../formatValidationError";

export const ConfirmedProfileSchema = z.object({
  contact: z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phoneNumber: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    addressLine1: z.string().nullable(),
  }),
  yearsOfExperience: z.number().int().nonnegative().nullable(),
  workAuthorizationNotes: z.string().nullable(),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      fieldOfStudy: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      gpa: z.string().nullable(),
    })
  ),
  workExperiences: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      employmentType: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      bullets: z.array(z.string().min(1)),
    })
  ),
  skills: z.array(z.object({ name: z.string(), category: z.string().nullable() })),
  projects: z.array(z.object({ name: z.string(), description: z.string(), url: z.string().nullable() })),
  certifications: z.array(
    z.object({
      name: z.string(),
      issuer: z.string(),
      issueDate: z.string().nullable(),
      expiryDate: z.string().nullable(),
    })
  ),
  achievements: z.array(z.string()),
});

export type ConfirmedProfile = z.infer<typeof ConfirmedProfileSchema>;
