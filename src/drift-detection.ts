{
  "code": "
// Import required modules
import { TaskPipeline } from './TaskPipeline';
import { D1DriftChecks } from './D1DriftChecks';
import { ReviewTask } from './ReviewTask';

// Define the drift detection step
async function detectDrift(task: TaskPipeline) {
  // Get the original task description (spec)
  const spec = task.spec;

  // Get the generated output (implementation)
  const implementation = task.implementation;

  // Spawn a review task
  const reviewTask = new ReviewTask(spec, implementation);

  // Check if all requirements from spec are addressed
  const requirementsMet = reviewTask.checkRequirements();

  // Check if no extra functionality is added beyond spec
  const extraFunctionality = reviewTask.checkExtraFunctionality();

  // Check if naming conventions are consistent
  const namingConventions = reviewTask.checkNamingConventions();

  // Check if error handling covers spec edge cases
  const errorHandling = reviewTask.checkErrorHandling();

  // Calculate the drift score (0-100)
  const driftScore = calculateDriftScore(requirementsMet, extraFunctionality, namingConventions, errorHandling);

  // Store the drift score in the D1