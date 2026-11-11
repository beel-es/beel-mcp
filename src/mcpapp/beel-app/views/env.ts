import type { Controller } from '../controller.js';
import type { AppState } from '../model.js';

/** What a view renders from: a state snapshot, the controller, the host's affordances. */
export interface ViewEnv {
  state: AppState;
  ctl: Controller;
  host: {
    /**
     * Shown in the conversation with a larger mode available: the panel is a
     * compact card (the essentials and one way in), not the whole workspace.
     */
    compact: boolean;
    /** Inline, with a side panel available to move to. */
    canExpand: boolean;
    expand(): void;
    canDownload: boolean;
  };
}
