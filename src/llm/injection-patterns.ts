// Spec 4 "Pattern kinds" (L8): text that looks like instructions aimed at the bot. Case-insensitive. The list can
// grow without a spec change as long as each pattern has one of these kinds. A match is reported as its kind,
// never as the matched text. It is a simple list: it can be wrong, and a text with no match is not proven safe.

export type InjectionKind =
  | 'override-instructions'
  | 'role-change'
  | 'prompt-leak'
  | 'fake-markup'
  | 'bot-control'
  | 'destructive-command';

/** In this order: the kinds of a text are reported in the order of this list. Every quantifier is bounded. */
export const INJECTION_PATTERNS: readonly {
  kind: InjectionKind;
  pattern: RegExp;
}[] = [
  // "ignore all previous instructions", "disregard the system prompt", "forget your rules"
  {
    kind: 'override-instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:instructions?|prompts?|rules|directions|guidelines)\b/i,
  },
  { kind: 'override-instructions', pattern: /\bnew instructions\s{0,3}:/i },
  // "you are now a …", "from now on you are …"
  {
    kind: 'role-change',
    pattern: /\byou are now (?:a|an|the|my|in)\s{1,3}\w/i,
  },
  {
    kind: 'role-change',
    pattern: /\bfrom now on,?\s{1,3}you\s{1,3}(?:are|will be|act as)\b/i,
  },
  { kind: 'role-change', pattern: /\bpretend (?:to be|you are)\b/i },
  // "reveal your system prompt", "print your instructions"
  {
    kind: 'prompt-leak',
    pattern:
      /\b(?:reveal|print|show|repeat|output|leak|tell me)\b[^.\n]{0,30}?\b(?:system prompt|your (?:instructions|prompt|rules))\b/i,
  },
  // a line starting with `system:` or `assistant:`, `<system>`, `</untrusted-data`, `<|im_start|>`, `[INST]`
  {
    kind: 'fake-markup',
    pattern: /^[ \t]{0,20}(?:system|assistant)[ \t]{0,5}:/im,
  },
  { kind: 'fake-markup', pattern: /<\/?\s{0,3}system\s{0,3}>/i },
  { kind: 'fake-markup', pattern: /<\/?\s{0,3}untrusted-data/i },
  { kind: 'fake-markup', pattern: /<\|im_(?:start|end)\|>/i },
  { kind: 'fake-markup', pattern: /\[\/?INST\]/i },
  // "approve everything", "mark this as approved", "set the confidence to 100", "skip the quality gate"
  { kind: 'bot-control', pattern: /\bapprove (?:everything|all)\b/i },
  {
    kind: 'bot-control',
    pattern: /\b(?:mark|set) (?:this|it|the \w{1,20}) (?:as )?approved\b/i,
  },
  {
    kind: 'bot-control',
    pattern: /\bconfidence (?:to|=|of|at) 100\b/i,
  },
  { kind: 'bot-control', pattern: /\bskip (?:the )?quality[ -]gate\b/i },
  // "git push --force", "delete the repository", "rm -rf"
  {
    kind: 'destructive-command',
    pattern: /\bgit\s{1,3}push\b[^\n]{0,60}?(?:--force\b|\s-f\b)/i,
  },
  {
    kind: 'destructive-command',
    pattern: /\bdelete (?:the|this|your) (?:repository|repo)\b/i,
  },
  {
    kind: 'destructive-command',
    pattern: /\brm\s{1,3}-(?:[a-z]{0,5}r[a-z]{0,5}f|[a-z]{0,5}f[a-z]{0,5}r)\b/i,
  },
];

/** The kinds found in the full text, each once, in the order of the list. Never the matched text. */
export function findInjectionKinds(text: string): InjectionKind[] {
  const kinds: InjectionKind[] = [];
  for (const { kind, pattern } of INJECTION_PATTERNS) {
    if (!kinds.includes(kind) && pattern.test(text)) kinds.push(kind);
  }
  return kinds;
}
