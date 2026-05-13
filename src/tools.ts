import { jsonSchema } from 'ai';

export const weatherTool = {
    description: '查询指定城市的天气信息',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            city: { type: 'string', description: '城市名称，如"北京"、"上海"' },
        },
        required: ['city'],
        additionalProperties: false,
    }),
    execute: async ({ city }: { city: string }) => {
        // 先用假数据，后面课程会接真实 API
        const mockWeather: Record<string, string> = {
            '北京': '晴，15-25°C，东南风 2 级',
            '上海': '多云，18-22°C，西南风 3 级',
            '深圳': '阵雨，22-28°C，南风 2 级',
        };
        return mockWeather[city] || `${city}：暂无数据`;
    },
};

export const calculatorTool = {
    description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' },
        },
        required: ['expression'],
        additionalProperties: false,
    }),
    execute: async ({ expression }: { expression: string }) => {
        try {
            // 生产环境不要用 eval，这里纯粹为了演示
            const result = new Function(`return ${expression}`)();
            return `${expression} = ${result}`;
        } catch {
            return `无法计算: ${expression}`;
        }
    },
};
