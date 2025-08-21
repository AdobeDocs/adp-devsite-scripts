const fs = require('fs');
const { hasMetadata } = require('./file-operation');

function determineComplexity(text) {
  const length = (text || '').length;
  const headings = (text.match(/^#+\s/mg) || []).length;
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
  const score = (length > 2000 ? 2 : length > 800 ? 1 : 0) + (headings > 6 ? 2 : headings > 2 ? 1 : 0) + (codeBlocks > 2 ? 2 : codeBlocks > 0 ? 1 : 0);
  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function getFAQCount(complexity) {
  if (complexity === 'high') return 5; // 1-5 → choose 5
  if (complexity === 'medium') return 3; // 1-3 → choose 3
  return 2; // low: 1-2 → choose 2
}

async function fetchWithRetry(url, options, retries = 3, backoffMs = 1000) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`Transient error: ${res.status}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastErr;
}

function sanitizeContent(text, maxLength = 8000) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function extractH1(text){
  try{
    const mdMatch = text.match(/^\s*#\s+(.+)$/m);
    if (mdMatch && mdMatch[1]) return mdMatch[1].trim();
    const htmlMatch = text.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (htmlMatch && htmlMatch[1]) return htmlMatch[1].trim();
  } catch(_e) {}
  return '';
}

function ensureTitleInFrontmatterBlock(frontmatterBlock, h1){
  if (!frontmatterBlock || !h1) return frontmatterBlock;
  const startIdx = frontmatterBlock.indexOf('---');
  if (startIdx !== 0) return frontmatterBlock; // expect starting with ---
  const endIdx = frontmatterBlock.indexOf('\n---', 3);
  if (endIdx === -1) return frontmatterBlock;
  const header = frontmatterBlock.slice(0, 3);
  const body = frontmatterBlock.slice(3, endIdx + 1); // includes leading newline
  const rest = frontmatterBlock.slice(endIdx + 4); // after closing --- and newline
  const hasTitle = /(^|\n)\s*title\s*:/i.test(body);
  if (hasTitle) return frontmatterBlock;
  // Insert title after the opening --- line
  const afterOpening = frontmatterBlock.replace(/^---\s*\n/, `---\ntitle: ${h1}\n`);
  return afterOpening;
}

async function createMetadata(endpoint, apiKey, filepath, content, faqCount) {
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system", // system prompt: sets the behavior and style of the AI assistant
          content: "You are an AI assistant that generates YAML frontmatter for documentation pages, including a title, description, keywords, and a concise FAQs section."
        },
        {
          role: "user", // user prompt: the specific task or request from the user to the AI assistant
          content: `Generate YAML frontmatter for the following content in this exact format (YAML between --- markers). Include a 'faqs' array with ${faqCount} items.
                ---
                title: [Same as the heading1 content]
                description: [Brief description of the document]
                keywords:
                - [Keyword 1]
                - [Keyword 2]
                - [Keyword 3]
                - [Keyword 4]
                - [Keyword 5]
                # --- FAQs ---
                faqs:
                - question: [Concise question 1]
                  answer: [Actionable, 1-3 sentence answer]
                - question: [Concise question 2]
                  answer: [Actionable, 1-3 sentence answer]
                ---
                Content: ${sanitizeContent(content)}`
        }
      ],
      max_tokens: 800,
      temperature: 1,
      top_p: 1,
    })
  });

  const result = await response.json();
  const aiContent = result.choices[0].message.content;

  return  `--- File: ${filepath} ---\n${aiContent}\n`;
}

async function createFAQ(endpoint, apiKey, filepath, content, faqCount) {
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: "You are an AI assistant that writes high-quality, concise FAQs for documentation."
        },
        {
          role: "user",
          content: `From the following documentation content, generate exactly ${faqCount} distinct FAQs as YAML list items with 'question' and 'answer' fields. Keep answers 1-3 sentences, practical, and specific to the content.
                Content: ${sanitizeContent(content)}`
        }
      ],
      max_tokens: 600,
      temperature: 1,
      top_p: 1,
    })
  });

  const result = await response.json();
  const aiContent = result.choices[0].message.content;
  // Expect aiContent to be YAML list; wrap into frontmatter fragment for merging if needed by the model output
  return aiContent;
}

async function EditMetadata(endpoint, apiKey, filepath, metadata, fileContent, faqCount) {
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: "You are an AI assistant that minimally updates YAML frontmatter: preserve existing fields, adjust only what is necessary, and add a concise 'faqs' array."
        },
        {
          role: "user",
          content: `Review and minimally update the following YAML frontmatter based on the page content. Keep all existing custom fields. Ensure the format matches exactly and append/update a 'faqs' array with ${faqCount} items.
    
            Expected format:
              ---
              title: [Same as the heading1 content]
              description: [Brief description of the document]
              keywords:
              - [Keyword 1]
              - [Keyword 2]
              - [Keyword 3]
              - [Keyword 4]
              - [Keyword 5]
              # --- FAQs ---
              faqs:
              - question: [Concise question 1]
                answer: [Actionable, 1-3 sentence answer]
              - question: [Concise question 2]
                answer: [Actionable, 1-3 sentence answer]
              other original metadata (preserve)
              ---

              Current metadata:
              ${metadata}

              Content to analyze:
              ${sanitizeContent(fileContent)}`
        }
      ],
      max_tokens: 800,
      temperature: 1,
      top_p: 1,
    })
  });

  const result = await response.json();
  const aiContent = result.choices[0].message.content;

  return `--- File: ${filepath} ---\n${aiContent}\n`;
}

// Main function to read content and generate metadata
module.exports = async ({ core, azureOpenAIEndpoint, azureOpenAIAPIKey, fileName }) => {
  if (!azureOpenAIEndpoint || !azureOpenAIAPIKey) {
    console.error('Missing required parameters: azureOpenAIEndpoint or azureOpenAIAPIKey');
    return;
  }

  if (!fileName) {
    console.error('Missing required parameter: fileName must be specified');
    return;
  }

  try {
    let content = fs.readFileSync(fileName, 'utf8');
    console.log(`Successfully read content from ${fileName}`);

    // Split content by file markers
    const fileContents = content.split(/--- File: (?=.*? ---)/);
    // Remove the first empty element if exists
    if (fileContents[0].trim() === '') {
      fileContents.shift();
    }

    let allGeneratedContent = '';

    for (const fileContent of fileContents) {
      if (!fileContent.trim()) continue;

      // Extract file path and content
      const pathMatch = fileContent.match(/(.*?) ---\n([\s\S]*)/);
      if (!pathMatch) continue;

      const [, filePath, fileText] = pathMatch;
      const cleanContent = fileText.trim();
      const h1 = extractH1(cleanContent);
      const complexity = determineComplexity(cleanContent);
      const faqCount = getFAQCount(complexity);

      if (hasMetadata(cleanContent)) {
        const parts = cleanContent.split('---');
        const metadata = parts.slice(1, 2).join('---').trim();
        const fullContent = parts.slice(2).join('---').trim();
        const edited = await EditMetadata(azureOpenAIEndpoint, azureOpenAIAPIKey, filePath, metadata, fullContent, faqCount);
        const ensured = ensureTitleInFrontmatterBlock(edited, h1);
        allGeneratedContent += ensured;
      } else {
        const fm = await createMetadata(azureOpenAIEndpoint, azureOpenAIAPIKey, filePath, cleanContent, faqCount);
        const ensured = ensureTitleInFrontmatterBlock(fm, h1);
        allGeneratedContent += ensured;
      }
    }

    fs.writeFileSync('ai_content.txt', allGeneratedContent, 'utf8');
    console.log('Successfully wrote all content to ai_content.txt');

  } catch (error) {
    console.error('Error processing content:', error);
  }
};

// Keep backwards compatibility - if run directly, use environment variables
if (require.main === module) {
    const azureOpenAIEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const azureOpenAIAPIKey = process.env.AZURE_OPENAI_API_KEY;
    const fileName = process.env.FILE_NAME;
    
    if (!azureOpenAIEndpoint) {
        console.error('Error: AZURE_OPENAI_ENDPOINT environment variable must be set when running directly');
        process.exit(1);
    }
    if (!azureOpenAIAPIKey) {
        console.error('Error: AZURE_OPENAI_API_KEY environment variable must be set when running directly');
        process.exit(1);
    }
    if (!fileName) {
        console.error('Error: FILE_NAME environment variable must be set when running directly');
        process.exit(1);
    }
    
    module.exports({
        core: null,
        azureOpenAIEndpoint,
        azureOpenAIAPIKey,
        fileName
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}