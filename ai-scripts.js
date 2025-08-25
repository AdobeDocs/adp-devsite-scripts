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
          content: `Generate YAML frontmatter for the following content. Add faqs section with ${faqCount} items. Return ONLY the YAML frontmatter block below - nothing else.

          Required format (include ONLY these fields):
          ---
          title: [Extract from H1 heading or create descriptive title]
          description: [Brief 1-2 sentence description]
          keywords:
          - [SEO keyword 1]
          - [SEO keyword 2] 
          - [SEO keyword 3]
          - [SEO keyword 4]
          - [SEO keyword 5]
          faqs - ${faqCount} questions and answers:
          - question: [Question 1]
            answer: [1-3 sentence answer]
          - question: [Question 2]
            answer: [1-3 sentence answer]
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

  // Clean any AI-generated file headers to prevent double headers
  const cleanContent = aiContent.replace(/^--- File: .* ---\n/gm, '');
  
  return cleanContent;
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
          content: "You are an AI assistant that updates YAML frontmatter. You must preserve ALL existing fields exactly as they are. Only enhance title/description/keywords if needed and add faqs. Never duplicate fields or add new field types."
        },
        {
          role: "user",
          content: `Update the YAML frontmatter below. CRITICAL RULES:
            - Keep ALL existing fields exactly as they are (preserve everything from current metadata)
            - Only modify title, description, keywords if they need improvement - keywords should be 5 total so add more if needed
            - Add faqs section with ${faqCount} items
            - Each field name can appear ONLY ONCE in your response
            - Never add new field types that weren't in the original

            Required format (include ONLY these fields):
            ---
            title: [Extract from H1 heading or create descriptive title]
            description: [Brief 1-2 sentence description]
            keywords:
            - [SEO keyword 1]
            - [SEO keyword 2] 
            - [SEO keyword 3]
            - [SEO keyword 4]
            - [SEO keyword 5]
            faqs - ${faqCount} questions and answers:
            - question: [Question 1]
              answer: [1-3 sentence answer]
            - question: [Question 2]
              answer: [1-3 sentence answer]
            ---

            Current metadata:
            ${metadata}

            Return a single YAML frontmatter block with:
            1. All original fields preserved exactly
            2. Enhanced title/description/keywords (5 total keywords for SEO)
            3. New faqs section
            4. No duplicate fields

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
  // Clean any AI-generated file headers to prevent double headers
  const cleanContent = aiContent.replace(/^--- File: .* ---\n/gm, '');
  return cleanContent;
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

    // Check if content is empty or contains "no files found" message
    if (!content || content.trim() === '') {
      throw new Error(`Input file ${fileName} is empty`);
    }

    // Check for "no files found" messages from upstream scripts
    if (content.includes('No matching files found')) {
      console.warn(`Warning: Upstream script reported no matching files: ${content.trim()}`);
      const warningMessage = `--- Warning ---\nNo files were found to process by the upstream script.\nReason: ${content.trim()}\n`;
      fs.writeFileSync('ai_content.txt', warningMessage, 'utf8');
      console.log('Wrote warning message to ai_content.txt');
      return;
    }

    // Split content by file markers
    const fileContents = content.split(/--- File: (?=.*? ---)/);
    // Remove the first empty element if exists
    if (fileContents[0].trim() === '') {
      fileContents.shift();
    }

    // Check if we have any valid file markers
    if (fileContents.length === 0) {
      throw new Error(`No valid file markers found in ${fileName}. Expected format: "--- File: path ---"`);
    }

    let allGeneratedContent = '';
    let processedFileCount = 0;

    for (const fileContent of fileContents) {
      if (!fileContent.trim()) continue;

      // Extract file path and content
      const pathMatch = fileContent.match(/(.*?) ---\n([\s\S]*)/);
      if (!pathMatch) {
        console.warn(`Skipping invalid file content section: ${fileContent.substring(0, 100)}...`);
        continue;
      }

      const [, filePath, fileText] = pathMatch;
      const cleanContent = fileText.trim();
      
      if (!cleanContent) {
        console.warn(`Skipping empty content for file: ${filePath}`);
        continue;
      }

      console.log(`Processing file: ${filePath}`);
      processedFileCount++;

      const h1 = extractH1(cleanContent);
      const complexity = determineComplexity(cleanContent);
      const faqCount = getFAQCount(complexity);

      if (hasMetadata(cleanContent)) {
        console.log("editing metadata")
        const parts = cleanContent.split('---');
        const metadata = parts.slice(1, 2).join('---').trim();
        const fullContent = parts.slice(2).join('---').trim();
        const edited = await EditMetadata(azureOpenAIEndpoint, azureOpenAIAPIKey, filePath, metadata, fullContent, faqCount);
        const ensured = ensureTitleInFrontmatterBlock(edited, h1);
        allGeneratedContent += `--- File: ${filePath} ---\n${ensured}`;
      } else {
        const fm = await createMetadata(azureOpenAIEndpoint, azureOpenAIAPIKey, filePath, cleanContent, faqCount);
        const ensured = ensureTitleInFrontmatterBlock(fm, h1);
        allGeneratedContent += `--- File: ${filePath} ---\n${ensured}`;
      }
    }

    // Validate that we actually processed some content
    if (processedFileCount === 0) {
      throw new Error('No valid files were processed. Check that the input file contains properly formatted file markers.');
    }

    if (!allGeneratedContent.trim()) {
      throw new Error('No content was generated. Check AI service connectivity and input file format.');
    }

    fs.writeFileSync('ai_content.txt', allGeneratedContent, 'utf8');
    console.log(`Successfully wrote content for ${processedFileCount} files to ai_content.txt`);

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