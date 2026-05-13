import { streamText, type ModelMessage } from 'ai';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';

const MAX_STEPS = 15;

export async function agentLoop(
    model: any,
    tools: any,
    messages: ModelMessage[],
    system: string,
) {
    let step = 0;
    resetHistory();

    while (step < MAX_STEPS) {
        step++;
        console.log(`\n--- Step ${step} ---`);

        const result = await streamText({ model, system, tools, messages, maxRetries: 0, onError: () => { } });

        let hasToolCall = false;
        let fullText = '';
        let shouldBreak = false;
        let lastToolCall: { name: string; input: unknown } | null = null;

        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'text-delta':
                    process.stdout.write(part.text);
                    fullText += part.text;
                    break;

                case 'tool-call': {
                    hasToolCall = true;
                    lastToolCall = { name: part.toolName, input: part.input };
                    console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

                    const detection = detect(part.toolName, part.input);
                    if (detection.stuck) {
                        console.log(`  ${detection.message}`);
                        if (detection.level === 'critical') {
                            shouldBreak = true;
                        } else {
                            messages.push({
                                role: 'user' as const,
                                content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                            });
                        }
                    }
                    recordCall(part.toolName, part.input);
                    break;
                }

                case 'tool-result':
                    console.log(`  [结果: ${JSON.stringify(part.output)}]`);
                    if (lastToolCall) {
                        recordResult(lastToolCall.name, lastToolCall.input, part.output);
                    }
                    break;
            }
        }

        if (shouldBreak) {
            console.log('\n[循环检测触发，Agent 已停止]');
            break;
        }

        const stepResult = await result.response;
        messages.push(...stepResult.messages);

        if (!hasToolCall) {
            if (fullText) console.log();
            break;
        }

        console.log('  → 继续下一步...');
    }

    if (step >= MAX_STEPS) {
        console.log('\n[达到最大步数限制，强制停止]');
    }
}
