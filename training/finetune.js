/**
 * OpenAI Fine-Tuning Pipeline
 *
 * Uploads dataset and creates a fine-tuning job on OpenAI.
 * Can also merge live experience data with generated datasets.
 *
 * Usage:
 *   node finetune.js upload <file.jsonl>          - Upload & start fine-tuning
 *   node finetune.js status <job_id>              - Check job status
 *   node finetune.js merge <output.jsonl> [dir]   - Merge all JSONL files in dir
 *   node finetune.js list                         - List fine-tuning jobs
 *
 * Environment:
 *   OPENAI_API_KEY       - Required
 *   OPENAI_BASE_MODEL    - Model to fine-tune (default: gpt-4o-mini-2024-07-18)
 *   OPENAI_EPOCHS        - Training epochs (default: 3)
 */

const fs = require('fs');
const path = require('path');

let OpenAI;
try {
  OpenAI = require('openai').default || require('openai');
} catch (e) {
  console.error('Install openai: npm install openai');
  process.exit(1);
}

const openai = new OpenAI();
const BASE_MODEL = process.env.OPENAI_BASE_MODEL || 'gpt-4o-mini-2024-07-18';
const EPOCHS = parseInt(process.env.OPENAI_EPOCHS) || 3;

async function uploadAndFinetune(filePath) {
  console.log(`Uploading ${filePath}...`);

  // Validate file
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
  console.log(`Dataset: ${lines.length} examples`);

  // Basic validation
  let valid = 0;
  let invalid = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.messages && Array.isArray(record.messages)) {
        valid++;
      } else {
        invalid++;
      }
    } catch {
      invalid++;
    }
  }
  console.log(`Valid: ${valid}, Invalid: ${invalid}`);

  if (valid < 10) {
    console.error('Need at least 10 valid examples for fine-tuning.');
    process.exit(1);
  }

  // Upload file
  const file = await openai.files.create({
    file: fs.createReadStream(filePath),
    purpose: 'fine-tune',
  });
  console.log(`File uploaded: ${file.id}`);

  // Create fine-tuning job
  const job = await openai.fineTuning.jobs.create({
    training_file: file.id,
    model: BASE_MODEL,
    hyperparameters: {
      n_epochs: EPOCHS,
    },
    suffix: 'civclash',
  });

  console.log(`\nFine-tuning job created!`);
  console.log(`  Job ID: ${job.id}`);
  console.log(`  Model: ${BASE_MODEL}`);
  console.log(`  Epochs: ${EPOCHS}`);
  console.log(`  Status: ${job.status}`);
  console.log(`\nCheck status: node finetune.js status ${job.id}`);
  console.log(`\nOnce complete, use the fine-tuned model:`);
  console.log(`  OPENAI_MODEL=ft:gpt-4o-mini:...  node openaiClient.js 0`);
}

async function checkStatus(jobId) {
  const job = await openai.fineTuning.jobs.retrieve(jobId);

  console.log(`Job: ${job.id}`);
  console.log(`Status: ${job.status}`);
  console.log(`Model: ${job.model}`);

  if (job.fine_tuned_model) {
    console.log(`\nFine-tuned model ready: ${job.fine_tuned_model}`);
    console.log(`\nUse it:`);
    console.log(`  OPENAI_MODEL=${job.fine_tuned_model} node openaiClient.js 0`);
  }

  if (job.error) {
    console.error(`Error: ${JSON.stringify(job.error)}`);
  }

  // Show events
  const events = await openai.fineTuning.jobs.listEvents(jobId, { limit: 10 });
  if (events.data.length > 0) {
    console.log(`\nRecent events:`);
    for (const event of events.data.reverse()) {
      console.log(`  [${event.level}] ${event.message}`);
    }
  }
}

async function listJobs() {
  const jobs = await openai.fineTuning.jobs.list({ limit: 10 });

  console.log('Recent fine-tuning jobs:\n');
  for (const job of jobs.data) {
    const model = job.fine_tuned_model || 'pending';
    console.log(`  ${job.id} | ${job.status} | ${job.model} → ${model}`);
  }
}

function mergeFiles(outputPath, dir) {
  const sourceDir = dir || path.join(__dirname, 'data');
  const experienceDir = path.join(__dirname, 'experience');

  console.log(`Merging JSONL files from:`);
  console.log(`  ${sourceDir}`);
  if (fs.existsSync(experienceDir)) {
    console.log(`  ${experienceDir}`);
  }

  const allFiles = [];

  // Collect from data dir
  if (fs.existsSync(sourceDir)) {
    for (const f of fs.readdirSync(sourceDir)) {
      if (f.endsWith('.jsonl') && f.startsWith('dataset_')) {
        allFiles.push(path.join(sourceDir, f));
      }
    }
  }

  // Collect from experience dir (live game data)
  if (fs.existsSync(experienceDir)) {
    for (const f of fs.readdirSync(experienceDir)) {
      if (f.endsWith('.jsonl') && f.includes('_win')) {
        // Only include winning games
        allFiles.push(path.join(experienceDir, f));
      }
    }
  }

  console.log(`\nFound ${allFiles.length} files to merge`);

  const output = fs.createWriteStream(outputPath);
  let totalLines = 0;

  for (const file of allFiles) {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.messages && Array.isArray(record.messages)) {
          output.write(line + '\n');
          totalLines++;
        }
      } catch {}
    }
    console.log(`  ${path.basename(file)}: ${lines.length} lines`);
  }

  output.end();
  console.log(`\nMerged ${totalLines} examples → ${outputPath}`);
}

// --- CLI ---
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

switch (command) {
  case 'upload':
    if (!arg1) {
      console.error('Usage: node finetune.js upload <file.jsonl>');
      process.exit(1);
    }
    uploadAndFinetune(arg1).catch(console.error);
    break;

  case 'status':
    if (!arg1) {
      console.error('Usage: node finetune.js status <job_id>');
      process.exit(1);
    }
    checkStatus(arg1).catch(console.error);
    break;

  case 'list':
    listJobs().catch(console.error);
    break;

  case 'merge':
    if (!arg1) {
      console.error('Usage: node finetune.js merge <output.jsonl> [source_dir]');
      process.exit(1);
    }
    mergeFiles(arg1, arg2);
    break;

  default:
    console.log(`OpenAI Fine-Tuning Pipeline for Civilization Clash

Usage:
  node finetune.js upload <file.jsonl>          Upload & start fine-tuning
  node finetune.js status <job_id>              Check job status
  node finetune.js list                         List fine-tuning jobs
  node finetune.js merge <output.jsonl> [dir]   Merge datasets + experience

Workflow:
  1. Generate dataset:  node generate-dataset.js 500 tournament
  2. Upload & train:    node finetune.js upload data/dataset_*.jsonl
  3. Check progress:    node finetune.js status <job_id>
  4. Play with model:   OPENAI_MODEL=ft:... node ../agents/openaiClient.js 0

Live learning workflow:
  1. Play games:        OPENAI_LEARN=true node ../agents/openaiClient.js 0
  2. Merge experience:  node finetune.js merge data/merged.jsonl
  3. Fine-tune:         node finetune.js upload data/merged.jsonl`);
}
