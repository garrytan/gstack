import { capturePlanCountQuestion } from './claude-pty-runner';

/** Answer only gstack's routing setup prompt in the isolated autoplan fixture. */
export function autoplanRoutingSetupInput(visible: string, seen: Set<string>): string | null {
  const question = capturePlanCountQuestion(visible, seen, 0, true);
  if (!question) return null;

  // Live captures vary in wording and can lose characters from the qid.
  // Require an explicit CLAUDE.md skill-routing setup question plus both
  // named setup actions; a routing qid or a generic recommendation alone
  // cannot authorize answering a review/taste question.
  const prompt = question.promptSnippet.replace(/\s+/g, '');
  if (!/gstackworksbestwhenyourproject['’]sCLAUDE\.mdincludesskillroutingrules\.Addthemnow\?/i.test(prompt) &&
      !/Addgstackskillroutingrulesto(?:thisproject['’]s)?CLAUDE\.md\?/i.test(prompt)) {
    return null;
  }
  const options = question.options.map(option => ({
    index: option.index,
    title: option.label.split(/[│┌\r\n]/, 1)[0]!.replace(/\s+/g, ''),
  }));
  const add = options.find(option => /^Add(?:routingrules(?:toCLAUDE\.md)?|toCLAUDE\.md)(?:\(Recommended\))?$/i.test(option.title));
  const decline = options.find(option => /^(?:Nothanks(?:,manual|,I['’]llinvokeskillsmanually)?|Skip[—–-]invoke(?:skills)?manually)(?:\(Recommended\))?$/i.test(option.title));
  if (!add || !decline) return null;
  return `${add.index}\r`;
}
