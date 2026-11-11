import type { Controller } from '../controller.js';
import type { AppState } from '../model.js';

/** What a view renders from: a state snapshot, the controller, the host's affordances. */
export interface ViewEnv {
  state: AppState;
  ctl: Controller;
  host: {
    /** Inline, with a side panel available to move to. */
    canExpand: boolean;
    expand(): void;
    canDownload: boolean;
  };
}
