import { capturePlanCountQuestion } from './claude-pty-runner';

/** Answer only gstack's routing setup prompt in the isolated autoplan fixture. */
export function autoplanRoutingSetupInput(visible: string, seen: Set<string>): string | null {
  const question = capturePlanCountQuestion(visible, seen, 0, true);
  if (!question) return null;

  // The live capture lost characters from its qid, so require the full setup
  // question and both specific choices instead of guessing from a qid fragment.
  const prompt = question.promptSnippet.replace(/\s+/g, '');
  if (!/gstackworksbestwhenyourproject['’]sCLAUDE\.mdincludesskillroutingrules\.Addthemnow\?/i.test(prompt)) {
    return null;
  }
  const options = question.options.map(option => ({
    index: option.index,
    title: option.label.split(/[│┌\r\n]/, 1)[0]!.replace(/\s+/g, ''),
  }));
  const add = options.find(option => /^Addroutingrules(?:toCLAUDE\.md)?(?:\(Recommended\))?$/i.test(option.title));
  const decline = options.find(option => /^Nothanks(?:,I['’]llinvokeskillsmanually)?(?:\(Recommended\))?$/i.test(option.title));
  if (!add || !decline) return null;
  return `${add.index}\r`;
}
