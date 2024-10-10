// Import necessary modules using ESM syntax
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Configuration, OpenAIApi } from 'openai';
import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { promises as fs } from 'fs';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

// Initialize Hono app
const app = new Hono();
const port = 3000;

// Enable CORS middleware
app.use('*', cors());

// Initialize OpenAI configuration
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY, // Ensure your OpenAI API key is set in environment variables
});
const openai = new OpenAIApi(configuration);

// Define the directory to store scraped data
const SCRAPES_DIR = path.join(process.cwd(), 'scrapes');

// Ensure the scrapes directory exists
const ensureScrapesDir = async () => {
  try {
    await fs.access(SCRAPES_DIR);
  } catch {
    await fs.mkdir(SCRAPES_DIR, { recursive: true });
  }
};

// Call the function to ensure scrapes directory exists at startup
ensureScrapesDir();

// Endpoint to start scraping based on a given URL
app.post('/scrape', async (c) => {
  try {
    // Parse JSON body to get the URL
    const { url } = await c.req.json();

    // Validate URL
    if (!url) {
      return c.json({ error: 'URL is required' }, 400);
    }

    // Fetch the HTML content of the URL
    const response = await axios.get(url);
    const html = response.data;

    // Load HTML into cheerio for parsing
    const $ = cheerio.load(html);

    // Extract text content from the body
    const data = $('body').text();

    // Create a structured object for the scrape
    const scrape = {
      url,
      timestamp: new Date().toISOString(),
      data,
    };

    // Generate a unique filename based on timestamp
    const filename = `scrape-${Date.now()}.json`;
    const filepath = path.join(SCRAPES_DIR, filename);

    // Write the scrape data to a JSON file
    await fs.writeFile(filepath, JSON.stringify(scrape, null, 2), 'utf-8');

    // Respond with success message and filename
    return c.json({ message: 'Scraping completed successfully', file: filename });
  } catch (error) {
    // Handle errors during scraping
    return c.json({ error: 'Failed to scrape the provided URL' }, 500);
  }
});

// Endpoint to process a query with the extracted data using ChatGPT
app.post('/query', async (c) => {
  try {
    // Parse JSON body to get the query and optional filename
    const { query, file } = await c.req.json();

    // Validate query
    if (!query) {
      return c.json({ error: 'Query is required' }, 400);
    }

    let filepath: string;

    if (file) {
      // Use the specified file
      filepath = path.join(SCRAPES_DIR, file);
      try {
        await fs.access(filepath);
      } catch {
        return c.json({ error: 'Specified file does not exist' }, 400);
      }
    } else {
      // Use the latest scrape file

      // Read all files in the scrapes directory
      const files = await fs.readdir(SCRAPES_DIR);

      if (files.length === 0) {
        return c.json({ error: 'No scraped data available. Please scrape a URL first.' }, 400);
      }

      // Map files to their stats
      const filesWithStats = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(SCRAPES_DIR, file);
          const stats = await fs.stat(filePath);
          return { file, birthtimeMs: stats.birthtimeMs };
        })
      );

      // Sort files by creation time descending
      filesWithStats.sort((a, b) => b.birthtimeMs - a.birthtimeMs);

      // Select the latest file
      filepath = path.join(SCRAPES_DIR, filesWithStats[0].file);
    }

    // Read the scraped data from the file
    const fileContent = await fs.readFile(filepath, 'utf-8');
    const scrape = JSON.parse(fileContent);

    // Send prompt to OpenAI with the scraped data and user query
    const completion = await openai.createChatCompletion({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `Here is some data from ${scrape.url} at ${scrape.timestamp}: ${scrape.data}` },
        { role: 'user', content: query },
      ],
    });

    // Extract the response from OpenAI
    const answer = completion.data.choices[0].message?.content;

    // Respond with the answer
    return c.json({ answer });
  } catch (error) {
    // Handle errors during OpenAI request
    return c.json({ error: 'Failed to process the query with ChatGPT' }, 500);
  }
});
// Start the Hono server
serve(app).on('listening', () => {
  console.log(`Server running on port ${port}`);
});
