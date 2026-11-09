import {productionLearningAutomation, learningOwner} from "./learning-deps.js";
import {targetLearningCall} from "../../../runtime/src/learning/experiment.js";
import {NodeVerificationProcessRunner} from "../../../runtime/src/verify/spawn.js";

// The parent persists ownership before releasing this dormant entry. A lost handshake never spends.
const started = await new Promise<boolean>(resolve => {
  process.once("message", message => resolve(message === "start"));
  process.once("disconnect", () => resolve(false));
});
if (started) {
  const [root, id, token] = process.argv.slice(2);
  if (root && id && token) {
    const controller = await productionLearningAutomation(root, true);
    const job = (await controller.read()).jobs.find(j => j.id === id && j.token === token);
    if (job !== undefined) {
      const owner = await learningOwner();
      // Children share this detached worker's group so recovery can observe unfinished provider descendants.
      const runner = new NodeVerificationProcessRunner({processGroupId: owner.pid});
      await controller.execute(id, token, targetLearningCall(job.input.setup.settings, runner));
    }
  }
}
