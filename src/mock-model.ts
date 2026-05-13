/**
 * Mock Model v0.3 — 支持 Tool Calling + 死循环模拟
 */

let retryTestCount = 0;

const TEXT_RESPONSES: Record<string, string> = {
    default:
        '你好！我是 Super Agent 的模拟模型。当前使用本地模拟回复，工具调用的机制和真实 API 完全一样。\n\n在 .env 里填入 DASHSCOPE_API_KEY 即可切换到真实的 Qwen 模型。',
    greeting:
        '你好！我是 Super Agent v0.3，现在我不只能聊天，还有保险丝保护了 :)',
    name: '你刚才告诉我了呀！不过说实话，我是模拟模型，能“记住”是因为代码把对话历史传给了我。',
};

interface ToolCallIntent {
    toolName: string;
    args: Record<string, unknown>;
}

function extractUserText(prompt: any[]): string {
    const userMsgs = (prompt || []).filter((m: any) => m.role === 'user');
    const last = userMsgs[userMsgs.length - 1];
    if (!last) return '';
    return (last.content || [])
        .map((c: any) => c.text || '')
        .join('')
        .toLowerCase();
}

function hasToolResults(prompt: any[]): boolean {
    return (prompt || []).some((m: any) => m.role === 'tool');
}

function detectToolIntent(prompt: any[]): ToolCallIntent | null {
    const text = extractUserText(prompt);

    if (text.includes('测试死循环') || text.includes('test dead loop')) {
        return { toolName: 'get_weather', args: { city: '北京' } };
    }

    if (hasToolResults(prompt)) return null;

    const weatherKeywords = ['天气', 'weather', '温度', '热', '冷', '气温', '下雨', '晴'];
    const hasWeatherIntent = weatherKeywords.some((kw) => text.includes(kw));
    const cities = text.match(/(北京|上海|深圳|广州|杭州|成都)/g);
    if (hasWeatherIntent && cities && cities.length > 0) {
        return { toolName: 'get_weather', args: { city: cities[0] } };
    }

    const calcMatch = text.match(/(\d+)\s*[+\-*/加减乘除]\s*(\d+)/);
    if (calcMatch) {
        const op = text.match(/[+*/]|加|减|乘|除|-/)?.[0] || '+';
        const opMap: Record<string, string> = { '加': '+', '减': '-', '乘': '*', '除': '/' };
        const expression = `${calcMatch[1]} ${opMap[op] || op} ${calcMatch[2]}`;
        return { toolName: 'calculator', args: { expression } };
    }
    if (text.includes('计算') || text.includes('等于')) {
        const nums = text.match(/\d+/g);
        if (nums && nums.length >= 2) {
            return { toolName: 'calculator', args: { expression: `${nums[0]} + ${nums[1]}` } };
        }
    }

    return null;
}

function pickTextResponse(prompt: any[]): string {
    if (hasToolResults(prompt)) {
        const toolMsgs = (prompt || []).filter((m: any) => m.role === 'tool');
        const lastResult = toolMsgs[toolMsgs.length - 1];
        const content = (lastResult?.content || [])
            .map((c: any) => {
                if (c.output?.value) return c.output.value;
                if (c.output) return String(c.output);
                return c.text || c.result || '';
            })
            .join('');
        if (content.includes('°C') || content.includes('天气')) return `根据查询结果：${content}`;
        if (content.includes('=')) return `计算结果：${content}`;
        return `工具返回了以下信息：${content}`;
    }
    const text = extractUserText(prompt);
    if (text.includes('你好') || text.includes('hello') || text.includes('hi'))
        return TEXT_RESPONSES.greeting;
    if (text.includes('叫什么') || text.includes('名字') || text.includes('记'))
        return TEXT_RESPONSES.name;
    return TEXT_RESPONSES.default;
}

const USAGE = {
    inputTokens: { total: 3000, noCache: 3000, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1500, text: 1500, reasoning: undefined },
};

function createDelayedStream(chunks: any[], delayMs = 30): ReadableStream {
    return new ReadableStream({
        start(controller) {
            let i = 0;
            function next() {
                if (i < chunks.length) {
                    controller.enqueue(chunks[i++]);
                    setTimeout(next, delayMs);
                } else {
                    controller.close();
                }
            }
            next();
        },
    });
}

export function createMockModel() {
    return {
        specificationVersion: 'v2' as const,
        provider: 'mock',
        modelId: 'mock-model',

        get supportedUrls() {
            return Promise.resolve({});
        },

        async doGenerate({ prompt }: any) {
            const text = extractUserText(prompt);

            if (text.includes('测试重试') || text.includes('test retry')) {
                retryTestCount++;
                if (retryTestCount <= 2) {
                    throw new Error('429 Too Many Requests - Rate limit exceeded');
                }
                retryTestCount = 0;
                return {
                    content: [{ type: 'text' as const, text: '重试成功！经过几次 429 错误后，我终于回来了。' }],
                    finishReason: { unified: 'stop' as const, raw: undefined },
                    usage: USAGE,
                    warnings: [],
                };
            }

            const intent = detectToolIntent(prompt);
            if (intent) {
                return {
                    content: [{
                        type: 'tool-call' as const,
                        toolCallId: `call-${Date.now()}`,
                        toolName: intent.toolName,
                        input: intent.args,
                    }],
                    finishReason: { unified: 'tool-calls' as const, raw: undefined },
                    usage: USAGE,
                    warnings: [],
                };
            }

            return {
                content: [{ type: 'text' as const, text: pickTextResponse(prompt) }],
                finishReason: { unified: 'stop' as const, raw: undefined },
                usage: USAGE,
                warnings: [],
            };
        },

        async doStream({ prompt }: any) {
            const text = extractUserText(prompt);

            if (text.includes('测试重试') || text.includes('test retry')) {
                retryTestCount++;
                if (retryTestCount <= 2) {
                    throw new Error('429 Too Many Requests - Rate limit exceeded');
                }
                retryTestCount = 0;
                const reply = '重试成功！经过几次 429 错误后，我终于回来了。';
                const id = 'text-1';
                const chunks: any[] = [
                    { type: 'text-start', id },
                    ...reply.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
                    { type: 'text-end', id },
                    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
                ];
                return { stream: createDelayedStream(chunks, 30) };
            }

            const intent = detectToolIntent(prompt);
            if (intent) {
                const callId = `call-${Date.now()}`;
                const argsJson = JSON.stringify(intent.args);
                const chunks: any[] = [
                    { type: 'tool-input-start', id: callId, toolName: intent.toolName },
                    { type: 'tool-input-delta', id: callId, delta: argsJson },
                    { type: 'tool-input-end', id: callId },
                    { type: 'tool-call', toolCallId: callId, toolName: intent.toolName, input: argsJson },
                    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
                ];
                return { stream: createDelayedStream(chunks, 20) };
            }

            const replyText = pickTextResponse(prompt);
            const id = 'text-1';
            const chunks: any[] = [
                { type: 'text-start', id },
                ...replyText.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
                { type: 'text-end', id },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
            ];
            return { stream: createDelayedStream(chunks, 30) };
        },
    };
}
