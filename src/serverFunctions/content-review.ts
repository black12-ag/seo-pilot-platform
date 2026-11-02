import { createServerFn } from "@tanstack/react-start";
import { ContentReviewService } from "@/server/features/content/services/ContentReviewService";
import { AppError } from "@/server/lib/errors";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getContentRevisionInputSchema,
  saveContentRevisionInputSchema,
} from "@/types/schemas/content";
import {
  decideContentReviewInputSchema,
  getContentReviewInputSchema,
  requestContentReviewInputSchema,
  withdrawContentApprovalInputSchema,
} from "@/types/schemas/contentReview";

function webActor(
  context: {
    userId: string;
    organizationId: string;
    role: string;
    projectId: string;
  },
  projectId: string,
) {
  if (projectId !== context.projectId) throw new AppError("NOT_FOUND");
  return {
    userId: context.userId,
    organizationId: context.organizationId,
    role: context.role,
    surface: "web" as const,
  };
}
export const getContentReview = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(getContentReviewInputSchema)
  .handler(async ({ context, data }) =>
    ContentReviewService.get(webActor(context, data.projectId), data),
  );
export const requestContentReview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(requestContentReviewInputSchema)
  .handler(async ({ context, data }) =>
    ContentReviewService.request(webActor(context, data.projectId), data),
  );
export const decideContentReview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(decideContentReviewInputSchema)
  .handler(async ({ context, data }) =>
    ContentReviewService.decide(webActor(context, data.projectId), data),
  );
export const withdrawContentApproval = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(withdrawContentApprovalInputSchema)
  .handler(async ({ context, data }) =>
    ContentReviewService.withdraw(webActor(context, data.projectId), data),
  );

export const getContentEligibility = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(
    saveContentRevisionInputSchema
      .pick({ projectId: true, contentId: true, expectedHeadVersion: true })
      .extend({ revisionId: getContentRevisionInputSchema.shape.contentId }),
  )
  .handler(async ({ context, data }) => {
    const result = await ContentReviewService.currentEligibility(
      webActor(context, data.projectId),
      data,
    );
    return result.eligible
      ? { eligible: true as const }
      : { eligible: false as const, reason: result.reason };
  });
