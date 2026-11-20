import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "./canvasClient.js";
import type { Anonymizer } from "./anonymizer.js";
import type { SchoolConfig } from "./schoolConfig.js";
import type { Skill } from "./skills.js";
import { registerCompetencyTools } from "./tools/competencies.js";
import { registerSchoolInfoTools } from "./tools/school.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerModuleTools } from "./tools/modules.js";
import { registerPageTools } from "./tools/pages.js";
import { registerQuizTools } from "./tools/quizzes.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerRubricTools } from "./tools/rubrics.js";
import { registerUserTools } from "./tools/users.js";
import { registerSubmissionTools } from "./tools/submissions.js";
import { registerDiscussionTools } from "./tools/discussions.js";
import { registerGradingTools } from "./tools/grading.js";
import { registerCodeExecutionTools } from "./tools/code_exec.js";
import { registerAnonymizationTools } from "./tools/anonymization.js";
import { registerCourseContentTools } from "./tools/courseContent.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerOutcomeTools } from "./tools/outcomes.js";
import { registerOutcomeRubricTools } from "./tools/outcomeRubrics.js";
import { registerDiscussionEntryTools } from "./tools/discussionEntries.js";
import { registerContentMigrationTools } from "./tools/contentMigrations.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerPeerReviewTools } from "./tools/peerReviews.js";
import { registerAccessibilityTools } from "./tools/accessibility.js";
import { registerSkillTools } from "./tools/skills.js";

export interface ToolDependencies {
  canvas: CanvasClient;
  anonymizer: Anonymizer;
  schoolConfig: SchoolConfig | null;
  skills: Skill[];
  codeExecution: boolean;
}

/** Every tool the server exposes. Shared by the entry point and the tool-metadata tests. */
export function registerAllTools(server: McpServer, deps: ToolDependencies): void {
  const { canvas, anonymizer, schoolConfig, skills } = deps;
  // Phase 2 tools — anonymizer is wired into every student-data tool before
  // those tools become callable (FERPA gate per plan).
  registerCourseTools(server, canvas);
  registerModuleTools(server, canvas);
  registerPageTools(server, canvas, schoolConfig);
  registerQuizTools(server, canvas);
  registerAssignmentTools(server, canvas, anonymizer, schoolConfig);
  registerRubricTools(server, canvas);
  registerUserTools(server, canvas, anonymizer);
  registerSubmissionTools(server, canvas, anonymizer);
  registerDiscussionTools(server, canvas, anonymizer);
  registerGradingTools(server, canvas);
  registerAnonymizationTools(server, canvas, anonymizer);
  registerCompetencyTools(server, schoolConfig);
  registerSchoolInfoTools(server, schoolConfig);
  registerCourseContentTools(server, canvas);
  registerMessagingTools(server, canvas, anonymizer);
  registerAnalyticsTools(server, canvas, anonymizer);
  registerOutcomeTools(server, canvas, anonymizer);
  registerOutcomeRubricTools(server, canvas);
  registerDiscussionEntryTools(server, canvas, anonymizer);
  registerContentMigrationTools(server, canvas);
  registerGroupTools(server, canvas, anonymizer);
  registerPeerReviewTools(server, canvas, anonymizer);
  registerAccessibilityTools(server, canvas);
  registerSkillTools(server, skills);
  // execute_typescript runs model-written code on the teacher's machine. Off by
  // default for the distributed installer; a power user opts in from the
  // install dialog.
  if (deps.codeExecution) {
    registerCodeExecutionTools(server, anonymizer);
  }
}
