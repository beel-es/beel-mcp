/// <reference lib="dom" />
/**
 * The BeeL. app's icons: the same Lucide icons, at the same version, that the
 * BeeL web app uses for the same actions and states (here through `lucide`, the
 * framework-free build). The mapping mirrors the web app's: Banknote to mark
 * paid, Send, Download, FileCheck to issue, and a shield per VeriFactu state.
 *
 * Only the icons imported here reach the bundle; Lucide is tree-shaken.
 */
import {
  ArrowLeft,
  Banknote,
  createElement,
  Download,
  Eye,
  FileCheck,
  FileWarning,
  MessageSquare,
  Plus,
  RefreshCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldMinus,
  ShieldOff,
  ShieldX,
  UserPlus,
} from 'lucide';

const ICONS = {
  // Actions
  send: Send,
  markPaid: Banknote,
  view: Eye,
  download: Download,
  issue: FileCheck,
  correct: RefreshCcw,
  askClaude: MessageSquare,
  newInvoice: Plus,
  newCustomer: UserPlus,
  search: Search,
  back: ArrowLeft,
  // VeriFactu: the shield of each state on the invoice page, and the icon that
  // replaces the list dot for a record to look at twice.
  shieldPending: ShieldEllipsis,
  shieldAccepted: ShieldCheck,
  shieldReview: ShieldAlert,
  shieldVoided: ShieldMinus,
  shieldRejected: ShieldX,
  shieldNotSubmitted: ShieldOff,
  review: FileWarning,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * A decorative icon: the control or badge it sits in names it. 16 px in a
 * button (`h-4 w-4` in the web app), 14 px in a badge (`h-3.5 w-3.5`).
 */
export function icon(name: IconName, size: 14 | 16 = 16): SVGElement {
  return createElement(ICONS[name], {
    width: size,
    height: size,
    'aria-hidden': 'true',
    focusable: 'false',
  });
}
