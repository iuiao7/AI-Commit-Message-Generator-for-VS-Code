import * as vscode from "vscode";

// API 提供者类型
export type APIProvider = "openai" | "claude" | "azure" | "custom";

// API 提供者配置接口
interface APIProviderConfig {
  provider: APIProvider;
  apiUrl: string;
  model: string;
  apiKey: string;
}

function getPrompt(locale: string): string {
  const language = locale === "zh" ? "Chinese Simplified" : "English";

  const PROMPT = `Consolidate ALL changes in the git diff into **A SINGLE** Conventional Commits message.

CORE PRINCIPLE: Regardless of how many files are changed, output **ONLY ONE Header and ONE Body**.

Requirements:
- **MUST** apply with ${language}
- Header: <type>(<scope>): <${language}, max 50 chars, imperative, no period>
- type must be one of [build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test]
- scope: Summarize all changes into one primary scope, accurately classify the commit scope. If uncertain, provide the best guess: Noun describing a section of the codebase. E.g.: areas, contacts, containers, orders, prices, settings, statistics, core, ui, config, yarn, gradle, deps, github-actions, release.
- **DO NOT** output multiple headers.
- Body: Required, use - bullets, grouped by logical functionality (e.g., "Fix build issues", "Optimize UI").
- **STRICTLY FORBIDDEN** to split by file (e.g., "feat(A): ... feat(B): ..." is WRONG).
- Ignore whitespace-only changes (unless style type)
- Output ONLY the commit message, no code blocks or explanation`;

  return PROMPT;
}

// 获取 API 提供者配置
function getAPIProviderConfig(): APIProviderConfig {
  const config = vscode.workspace.getConfiguration("ai-commit-message");
  const provider = config.get<string>("apiProvider", "openai") as APIProvider;
  const apiUrl = config.get<string>("apiUrl", getDefaultApiUrl(provider));
  const model = config.get<string>("model", getDefaultModel(provider));
  const apiKey = config.get<string>("apiKey", "");

  return { provider, apiUrl, model, apiKey };
}

// 获取默认 API URL
function getDefaultApiUrl(provider: APIProvider): string {
  const defaultUrls: Record<APIProvider, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    claude: "https://api.anthropic.com/v1/messages",
    azure:
      "https://{resource-name}.openai.azure.com/openai/deployments/{deployment-id}/chat/completions",
    custom: "",
  };
  return defaultUrls[provider];
}

// 获取默认模型
function getDefaultModel(provider: APIProvider): string {
  const defaultModels: Record<APIProvider, string> = {
    openai: "gpt-3.5-turbo",
    claude: "claude-3-5-sonnet-20241022",
    azure: "gpt-3.5-turbo",
    custom: "",
  };
  return defaultModels[provider];
}

// Claude API 请求体格式
interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
}

// OpenAI/Azure API 请求体格式
interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  top_p: number;
  stream?: boolean;
  stream_options?: object;
}

// Claude API 响应体格式
interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
}

// OpenAI/Azure API 响应体格式
interface OpenAIResponse {
  choices: Array<{ message: { content: string }; delta?: { content: string } }>;
}

// 调用 Claude API
async function callClaudeAPI(
  systemPrompt: string,
  userMessage: string,
  apiUrl: string,
  model: string,
  apiKey: string,
): Promise<string> {
  const body: ClaudeRequest = {
    model: model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Claude API Error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as ClaudeResponse;
  const content = data.content?.[0]?.text?.trim() || "";

  // 清理可能的代码块标记
  let cleanContent = content;
  if (cleanContent.startsWith("```")) {
    cleanContent = cleanContent
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "");
  }

  return cleanContent.trim();
}

// 调用 OpenAI/Azure API
async function callOpenAICompatibleAPI(
  systemPrompt: string,
  userMessage: string,
  apiUrl: string,
  model: string,
  apiKey: string,
  provider: APIProvider,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Azure 使用不同的认证方式
  if (provider === "azure") {
    headers["api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body: OpenAIRequest = {
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.2,
    top_p: 1.0,
    stream: true,
    stream_options: { include_usage: true },
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API Request Failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  if (onChunk && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep the last partial line in the buffer

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine === "data: [DONE]") {
          continue;
        }
        if (trimmedLine.startsWith("data: ")) {
          try {
            const jsonStr = trimmedLine.slice(6);
            const data = JSON.parse(jsonStr);
            const content = data.choices?.[0]?.delta?.content || "";
            if (content) {
              finalContent += content;
              onChunk(content);
            }
          } catch (e) {
            console.error("Error parsing stream data:", e);
          }
        }
      }
    }
    return finalContent.trim();
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content?.trim() || "";

  // 清理可能的代码块标记
  let cleanContent = content;
  if (cleanContent.startsWith("```")) {
    cleanContent = cleanContent
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "");
  }

  return cleanContent.trim();
}

export async function generateCommitMessage(
  diff: string,
  locale: string,
  apiKey: string,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const config = vscode.workspace.getConfiguration("ai-commit-message");
  const provider = config.get<string>("apiProvider", "openai") as APIProvider;
  const apiUrl = config.get<string>("apiUrl", getDefaultApiUrl(provider));
  const model = config.get<string>("model", getDefaultModel(provider));

  if (!apiKey) {
    throw new Error(
      locale === "zh" ? "API Key 未提供。" : "API Key is not provided.",
    );
  }

  const systemPrompt = getPrompt(locale);
  const userMessage = `Git Diff:\n${diff}`;

  try {
    if (provider === "claude") {
      return await callClaudeAPI(
        systemPrompt,
        userMessage,
        apiUrl,
        model,
        apiKey,
      );
    } else {
      return await callOpenAICompatibleAPI(
        systemPrompt,
        userMessage,
        apiUrl,
        model,
        apiKey,
        provider,
        onChunk,
      );
    }
  } catch (error: any) {
    throw new Error(
      locale === "zh"
        ? `生成提交消息失败: ${error.message}`
        : `Failed to generate commit message: ${error.message}`,
    );
  }
}
