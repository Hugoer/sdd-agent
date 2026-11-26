// In-memory IssueProvider for specs 2, 4 and 5 (spec 3, G13). Same rules as the GitHub adapter
// (labels named as on GitHub), no network. Seed state with the helpers, inspect it after the call.
import type {
  AccessLevel,
  CommentRef,
  IssueProvider,
  Lane,
  TaskRef,
  TaskStatus,
  UnifiedTask,
} from '../../src/contracts/issue-provider.js';
import { ProviderError } from '../../src/contracts/provider-error.js';
import type { StepName } from '../../src/contracts/step.js';

const STATUSES: TaskStatus[] = [
  'draft',
  'grilling',
  'spec-review',
  'plan-review',
  'ready-for-dev',
  'executing',
  'in-review',
  'needs-human',
];
const LANES: Lane[] = ['full-sdd', 'spec-code', 'code-only'];
/** Spec 4 "Model labels", in the fixed step order. */
const MODEL_LABELS: [StepName, string][] = [
  ['grill', 'model: max-grill'],
  ['spec', 'model: max-spec'],
  ['plan', 'model: max-plan'],
  ['code', 'model: max-code'],
  ['qualityGate', 'model: max-quality-gate'],
];
const BOT_LABELS = [
  ...STATUSES.map((status) => `status: ${status}`),
  'bot: working',
  ...LANES.map((lane) => `workflow: ${lane}`),
  'grill: skip',
  ...MODEL_LABELS.map(([, label]) => label),
];

interface FakeIssue {
  task: TaskRef;
  title: string;
  description: string;
  labels: string[];
  author: string;
  open: boolean;
}

interface FakeComment {
  id: string;
  externalRef: string;
  body: string;
  byBot: boolean;
  createdAt: Date;
}

export class InMemoryIssueProvider implements IssueProvider {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly repoLabels: string[] = [];
  private readonly issues = new Map<string, FakeIssue>();
  private readonly comments: FakeComment[] = [];
  private readonly accessLevels = new Map<string, AccessLevel>();
  /** Spec 6: the comments with the bot's 👀, per issue, in the order first acknowledged. */
  private readonly acknowledgements = new Map<string, string[]>();
  /** Spec 13 (plan FP15): the bot's reactions per comment (`<externalRef> <commentId>`), in the order added. */
  private readonly reactions = new Map<string, ('rocket' | 'eyes')[]>();
  private nextError: ProviderError | undefined;
  private readonly nextErrorOn = new Map<string, ProviderError>();
  private nextCommentId = 1;

  constructor(
    readonly repo = 'test-owner/test-repo',
    /** The bot's own login, as the GitHub adapter resolves it at startup. */
    readonly botLogin = 'test-app[bot]',
  ) {}

  // ── seeding and inspection ──

  seedIssue(issue: {
    number: number;
    id?: string;
    title?: string;
    description?: string;
    labels?: string[];
    author?: string;
  }): TaskRef {
    const task: TaskRef = {
      platform: 'GITHUB',
      id: issue.id ?? String(1000 + issue.number),
      externalRef: `${this.repo}#${issue.number}`,
    };
    this.issues.set(task.externalRef, {
      task,
      title: issue.title ?? `Issue ${issue.number}`,
      description: issue.description ?? '',
      labels: [...(issue.labels ?? [])],
      author: issue.author ?? 'issue-author',
      open: true,
    });
    return task;
  }

  /** A human edits the labels (not a provider method; not recorded): every label but `status: *` is replaced. */
  setHumanLabels(task: TaskRef, labels: string[]): void {
    const issue = this.issue(task);
    issue.labels = [
      ...issue.labels.filter((label) =>
        label.toLowerCase().startsWith('status: '),
      ),
      ...labels,
    ];
  }

  /** A human closes or reopens the issue (not a provider method; not recorded). */
  setOpen(task: TaskRef, open: boolean): void {
    this.issue(task).open = open;
  }

  seedComment(
    task: TaskRef,
    comment: { body: string; byBot: boolean },
  ): CommentRef {
    return this.addComment(task, comment.body, comment.byBot);
  }

  /** Spec 7 (plan P23): a human edits a comment, also the bot's (not a provider method; not recorded). */
  editComment(commentId: string, body: string): void {
    const found = this.comments.find((comment) => comment.id === commentId);
    if (!found) throw new Error(`no comment ${commentId} to edit`);
    found.body = body;
  }

  /** A human deletes a comment (not a provider method; not recorded). */
  deleteComment(commentId: string): void {
    const index = this.comments.findIndex(
      (comment) => comment.id === commentId,
    );
    if (index >= 0) this.comments.splice(index, 1);
  }

  /** What getAccessLevel answers for this login (default: 'none'). */
  setAccessLevel(login: string, level: AccessLevel): void {
    this.accessLevels.set(login.toLowerCase(), level);
  }

  /** The next provider call rejects with this error (and changes nothing). */
  failNext(error: ProviderError): void {
    this.nextError = error;
  }

  /** Spec 5: the next call of `method` rejects with this error (and changes nothing); other calls pass. */
  failNextOn(method: keyof IssueProvider, error: ProviderError): void {
    this.nextErrorOn.set(method, error);
  }

  labelsOf(task: TaskRef): string[] {
    return [...this.issue(task).labels];
  }

  commentsOf(task: TaskRef): { id: string; body: string; byBot: boolean }[] {
    return this.comments
      .filter((comment) => comment.externalRef === task.externalRef)
      .map(({ id, body, byBot }) => ({ id, body, byBot }));
  }

  /** Spec 6: the comment ids `acknowledgeComment` marked on this issue (each once, in order). */
  acknowledged(task: TaskRef): string[] {
    return [...(this.acknowledgements.get(task.externalRef) ?? [])];
  }

  /** Spec 13 (plan FP15): the bot's reactions on one comment (`rocket`, `eyes`), in the order added. */
  reactionsOf(task: TaskRef, commentId: string): ('rocket' | 'eyes')[] {
    return [...(this.reactions.get(`${task.externalRef} ${commentId}`) ?? [])];
  }

  // ── IssueProvider ──

  getTaskDetails(task: TaskRef): Promise<UnifiedTask> {
    return this.call('getTaskDetails', [task], () => {
      const issue = this.issue(task);
      return {
        ...issue.task,
        title: issue.title,
        description: issue.description,
        labels: [...issue.labels],
        author: issue.author,
        url: this.url(task),
        open: issue.open,
      };
    });
  }

  postComment(task: TaskRef, body: string): Promise<CommentRef> {
    return this.call('postComment', [task, body], () =>
      this.addComment(task, body, true),
    );
  }

  getComment(
    task: TaskRef,
    commentId: string,
  ): Promise<{ body: string; createdAt: Date } | null> {
    return this.call('getComment', [task, commentId], () => {
      this.issue(task);
      const found = this.comments.find(
        (comment) =>
          comment.id === commentId && comment.externalRef === task.externalRef,
      );
      return found ? { body: found.body, createdAt: found.createdAt } : null;
    });
  }

  findCommentByMarker(
    task: TaskRef,
    marker: string,
  ): Promise<CommentRef | null> {
    return this.call('findCommentByMarker', [task, marker], () => {
      if (marker === '')
        throw new ProviderError(
          'findCommentByMarker: empty marker',
          'permanent',
        );
      this.issue(task);
      const found = this.comments.find(
        (comment) =>
          comment.externalRef === task.externalRef &&
          comment.byBot &&
          comment.body.includes(marker),
      );
      return found ? this.ref(found) : null;
    });
  }

  setStatusLabel(task: TaskRef, status: TaskStatus): Promise<void> {
    return this.call('setStatusLabel', [task, status], () => {
      const issue = this.issue(task);
      const wanted = `status: ${status}`;
      if (!issue.labels.some((label) => same(label, wanted)))
        issue.labels.push(wanted);
      issue.labels = issue.labels.filter(
        (label) =>
          !label.toLowerCase().startsWith('status: ') || same(label, wanted),
      );
    });
  }

  removeLabel(task: TaskRef, label: string): Promise<void> {
    return this.call('removeLabel', [task, label], () => {
      const name = label.toLowerCase();
      const allowed =
        name.startsWith('workflow: ') ||
        name === 'grill: skip' ||
        MODEL_LABELS.some(([, model]) => model === name);
      if (!allowed) {
        throw new ProviderError(`removeLabel refuses "${label}"`, 'permanent');
      }
      const issue = this.issue(task);
      issue.labels = issue.labels.filter((existing) => !same(existing, label));
    });
  }

  /** Plan P6: checks only that the ref is in this repo (the adapter never reads the issue here). */
  getAccessLevel(task: TaskRef, login: string): Promise<AccessLevel> {
    return this.call('getAccessLevel', [task, login], () => {
      this.inRepo(task);
      return this.accessLevels.get(login.toLowerCase()) ?? 'none';
    });
  }

  /** Pure, like the adapter: not recorded in `calls`. */
  isSelf(login: string): boolean {
    return same(login, this.botLogin);
  }

  /** Spec 6: like the adapter, an unknown or deleted comment is not an error; twice changes nothing. */
  acknowledgeComment(task: TaskRef, commentId: string): Promise<void> {
    return this.call('acknowledgeComment', [task, commentId], () => {
      this.inRepo(task);
      const ids = this.acknowledgements.get(task.externalRef) ?? [];
      if (!ids.includes(commentId)) ids.push(commentId);
      this.acknowledgements.set(task.externalRef, ids);
      // Spec 13 BFW5: the 👀 replaces the bot's own 🚀.
      const key = `${task.externalRef} ${commentId}`;
      const own = (this.reactions.get(key) ?? []).filter(
        (reaction) => reaction !== 'rocket',
      );
      if (!own.includes('eyes')) own.push('eyes');
      this.reactions.set(key, own);
    });
  }

  /** Spec 13: like `acknowledgeComment`, an unknown or deleted comment is not an error; twice changes nothing. */
  reactWorking(task: TaskRef, commentId: string): Promise<void> {
    return this.call('reactWorking', [task, commentId], () => {
      this.inRepo(task);
      const key = `${task.externalRef} ${commentId}`;
      const own = this.reactions.get(key) ?? [];
      if (!own.includes('rocket')) own.push('rocket');
      this.reactions.set(key, own);
    });
  }

  /** Spec 13: adds or removes `bot: working`; removing a missing one is no error. */
  setWorkingLabel(task: TaskRef, shown: boolean): Promise<void> {
    return this.call('setWorkingLabel', [task, shown], () => {
      const issue = this.issue(task);
      issue.labels = issue.labels.filter(
        (label) => !same(label, 'bot: working'),
      );
      if (shown) issue.labels.push('bot: working');
    });
  }

  readControls(task: UnifiedTask): {
    lanes: Lane[];
    grillSkip: boolean;
    maxModelSteps: StepName[];
  } {
    const names = task.labels.map((label) => label.toLowerCase());
    return {
      lanes: LANES.filter((lane) => names.includes(`workflow: ${lane}`)),
      grillSkip: names.includes('grill: skip'),
      maxModelSteps: MODEL_LABELS.filter(([, label]) =>
        names.includes(label),
      ).map(([step]) => step),
    };
  }

  ensureLabels(): Promise<void> {
    return this.call('ensureLabels', [], () => {
      for (const label of BOT_LABELS) {
        if (!this.repoLabels.some((existing) => same(existing, label)))
          this.repoLabels.push(label);
      }
    });
  }

  // ── internals ──

  private call<T>(method: string, args: unknown[], run: () => T): Promise<T> {
    this.calls.push({ method, args });
    const error = this.nextError ?? this.nextErrorOn.get(method);
    if (this.nextError) this.nextError = undefined;
    else this.nextErrorOn.delete(method);
    // The executor turns a thrown error into a rejection.
    return new Promise((resolve) => {
      if (error) throw error;
      resolve(run());
    });
  }

  private inRepo(task: TaskRef): void {
    if (
      !task.externalRef.toLowerCase().startsWith(`${this.repo.toLowerCase()}#`)
    ) {
      throw new ProviderError(
        `${task.externalRef} is not in ${this.repo}`,
        'permanent',
      );
    }
  }

  private issue(task: TaskRef): FakeIssue {
    this.inRepo(task);
    const issue = this.issues.get(task.externalRef);
    if (!issue) {
      throw new ProviderError(
        `GitHub GET issue ${task.externalRef} → 404: Not Found`,
        'permanent',
        {
          status: 404,
        },
      );
    }
    return issue;
  }

  private addComment(task: TaskRef, body: string, byBot: boolean): CommentRef {
    this.issue(task);
    const comment: FakeComment = {
      id: String(this.nextCommentId++),
      externalRef: task.externalRef,
      body,
      byBot,
      createdAt: new Date(),
    };
    this.comments.push(comment);
    return this.ref(comment);
  }

  private ref(comment: FakeComment): CommentRef {
    return {
      id: comment.id,
      url: `${this.url({ externalRef: comment.externalRef })}#issuecomment-${comment.id}`,
      createdAt: comment.createdAt,
    };
  }

  private url(task: Pick<TaskRef, 'externalRef'>): string {
    const number = task.externalRef.split('#')[1];
    return `https://github.com/${this.repo}/issues/${number}`;
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
