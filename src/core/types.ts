export interface MailFolder {
  id: string;
  accountId: string;
  path: string;
  name: string;
  specialUse?: string[];
  subFolders?: MailFolder[];
}

export interface MessageHeader {
  id: number;
  date: Date | string;
  author: string;
  subject: string;
  read: boolean;
  junk?: boolean;
  junkScore?: number;
  flagged: boolean;
  tags: string[];
  folder?: MailFolder;
  headerMessageId: string;
  recipients: string[];
  ccList: string[];
  bccList: string[];
  size: number;
}

export type Verdict =
  | 'junk'
  | 'promo'
  | 'newsletter'
  | 'social'
  | 'notification'
  | 'security'
  | 'order'
  | 'travel'
  | 'finance'
  | 'personal'
  | 'important';

export const VERDICTS: Verdict[] = [
  'junk', 'promo', 'newsletter', 'social', 'notification', 'security', 'order', 'travel', 'finance', 'personal', 'important',
];

/** How a verdict is shown to the user. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  junk: 'junk',
  promo: 'promo',
  newsletter: 'newsletter',
  notification: 'notification',
  social: 'social',
  security: 'security',
  order: 'order update',
  travel: 'travel / booking',
  finance: 'bills / finance',
  personal: 'personal',
  important: 'important',
};

export type ActionKind =
  | 'delete'
  | 'move'
  | 'archive'
  | 'mark_read'
  | 'mark_unread'
  | 'mark_junk'
  | 'mark_not_junk'
  | 'flag'
  | 'unflag'
  | 'tag';

export const ACTION_KINDS: ActionKind[] = [
  'delete', 'move', 'archive', 'mark_read', 'mark_unread', 'mark_junk', 'mark_not_junk', 'flag', 'unflag', 'tag',
];

export const ACTION_LABELS: Record<ActionKind, string> = {
  delete: 'Move to Trash',
  move: 'Move',
  archive: 'Archive',
  mark_read: 'Mark as read',
  mark_unread: 'Mark as unread',
  mark_junk: 'Mark as junk',
  mark_not_junk: 'Mark as not junk',
  flag: 'Flag',
  unflag: 'Remove flag',
  tag: 'Tag',
};
