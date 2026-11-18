/** A notifier was throttled and delivery must remain pending until retryAt. */
export class NotificationRateLimitError extends Error {
  constructor(
    readonly retryAt: number,
    readonly newlyObserved: boolean,
    message = 'Notification delivery rate limited',
  ) {
    super(message);
    this.name = 'NotificationRateLimitError';
  }
}

export interface SlackChannelConfig {
  webhook: string;
}

interface SlackRichTextStyle {
  bold?: boolean;
}

interface SlackRichTextTextElement {
  type: 'text';
  text: string;
  style?: SlackRichTextStyle;
}

export interface SlackRichTextSectionElement {
  type: 'rich_text_section';
  elements: SlackRichTextTextElement[];
}

export interface SlackRichTextListElement {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  indent: number;
  elements: SlackRichTextSectionElement[];
}

export type SlackRichTextBlockElement =
  | SlackRichTextSectionElement
  | SlackRichTextListElement;

export interface SlackRichTextBlock {
  type: 'rich_text';
  elements: SlackRichTextBlockElement[];
}

interface SlackPlainTextElement {
  type: 'plain_text';
  text: string;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackPlainTextElement[];
}

type SlackBlock = SlackRichTextBlock | SlackContextBlock;

export interface NotificationsConfig {
  slack?: SlackChannelConfig;
}

export interface NotificationMessage {
  text: string;
  slack?: {
    blocks: SlackBlock[];
  };
}

export type NotificationContent = string | NotificationMessage;

export interface Notifier {
  name: 'slack';
  send(message: NotificationContent): Promise<void>;
}
