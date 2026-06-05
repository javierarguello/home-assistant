/**
 * Shared TaskManager singleton. The root-agent tools call `taskManager()` to
 * start/list tasks; `index.ts` configures its kiosk/announce callbacks and runs
 * init()/stop() over the same instance.
 */
import { TaskManager } from './manager.js';

let instance: TaskManager | undefined;

export function taskManager(): TaskManager {
  if (!instance) instance = new TaskManager();
  return instance;
}
