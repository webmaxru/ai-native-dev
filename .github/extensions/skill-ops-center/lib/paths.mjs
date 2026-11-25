import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where saved settings live: always under the Copilot home, never inside the extension folder.
 * The project-scope copy of this extension sits in a repository checkout, and a user-scope
 * reinstall replaces the extension folder, so both would otherwise lose or leak the settings.
 */
export function userArtifactsDir(env = process.env, home = homedir()) {
    return join(env.COPILOT_HOME || join(home, ".copilot"), "extensions", "skill-ops-center", "artifacts");
}
