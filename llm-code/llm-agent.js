import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import OpenAI from 'openai';
import axios from 'axios';
import * as cheerio from 'cheerio';

// CONFIGURATION & STATE
const client = new OpenAI({
    baseURL: process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1',
    apiKey: process.env.LITELLM_API_KEY,
});
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

const socket = new DjsConnect(process.env.BDI_URL, process.env.BDI_TOKEN);

// Agent's local memory of its state
const me = { id: null, name: '', x: null, y: null, score: 0 };

socket.on('you', (you) => {
    me.id = you.id;
    me.name = you.name;
    me.x = you.x;
    me.y = you.y;
    me.score = you.score;
});

// These are the exact functions the LLM can trigger autonomously.
const TOOLS = {
    get_my_position: async () => {
        if (me.x === null || me.y === null) return "Error: position not available yet.";
        return `Current state -> X: ${Math.round(me.x)}, Y: ${Math.round(me.y)}, Score: ${me.score}`;
    },
    
    move: async (direction) => {
        const normalized = direction.trim().toLowerCase();
        return new Promise((resolve) => {
            socket.emit('move', normalized, (status) => {
                if (status) resolve(`Successfully moved ${normalized}.`);
                else resolve(`Error: Failed to move ${normalized}. There might be a wall or player in the way.`);
            });
        });
    },

    chat: async (message) => {
        socket.emit('say', message);
        return `Successfully broadcasted message: "${message}"`;
    },

    getTemperature: async (location) => {
        try {
            // Step 10: Geocoding API to get latitude/longitude
            const geoRes = await axios.get(`https://geocoding-api.open-meteo.com/v1/search?name=${location}&count=1`);
            if (!geoRes.data.results) return `Error: Could not find coordinates for ${location}.`;
            const { latitude, longitude } = geoRes.data.results[0];
            
            // Step 10: Weather API using the coordinates
            const weatherRes = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
            const temp = weatherRes.data.current_weather.temperature;
            return `The current temperature in ${location} is ${temp}°C.`;
        } catch (error) {
            return `Error fetching weather: ${error.message}`;
        }
    },
    webSearch: async (input) => {
        try {
            // The LLM should send input in the format: "https://example.com | What is the main topic?"
            const parts = input.split('|');
            if (parts.length < 2) return "Error: Input must be formatted as 'URL | query'";
            
            const url = parts[0].trim();
            const query = parts[1].trim();

            console.log(`🌐 Fetching URL: ${url}`);
            
            // Fetch the HTML from the website
            const response = await axios.get(url);
            
            // Use cheerio to strip out all the code and leave only the readable text
            const $ = cheerio.load(response.data);
            $('script, style, nav, footer').remove(); // Remove junk code
            const rawText = $('body').text().replace(/\s+/g, ' ').trim();
            
            // LLMs have a memory limit. We return the first 4000 characters of the page.
            const snippet = rawText.substring(0, 4000);
            
            return `Here is the text from the webpage. Please read it and answer this query: "${query}". Webpage text: ${snippet}`;
        } catch (error) {
            return `Error fetching webpage: ${error.message}`;
        }
    }
};

// SYSTEM PROMPT
const SYSTEM_PROMPT = `You are an AI assistant controlling a robot in the DeliverooJS game.
Available tools:
- get_my_position(): returns your current x, y coordinates and score.
- move(direction): moves you one step. Valid inputs: up, down, left, right.
- chat(message): sends a message to the global game chat.
- getTemperature(location): returns the current temperature of a real-world city.
- webSearch(input): fetches a webpage to answer a question. You MUST format the Action Input exactly as "URL | query". Example: "https://en.wikipedia.org/wiki/Rome | What year was it founded?"

If you need to use a tool, output ONLY in this exact format:
Thought: <your brief reasoning>
Action: <tool name>
Action Input: <tool input>

If you have finished the user's request or no tool is needed, output ONLY in this format:
Final Answer: <your final response to the user>
`;

// EXECUTION LOOP
async function runAgentTurn(userInput, maxIterations = 6) {
    let messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userInput }
    ];

    console.log(`\n🗣️ Request received: "${userInput}"`);

    for (let i = 0; i < maxIterations; i++) {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: messages,
            temperature: 0.1, // Low temperature for deterministic reasoning
        });

        const assistantMessage = response.choices[0].message.content.trim();
        messages.push({ role: 'assistant', content: assistantMessage });
        console.log(`\n🤖 [LLM Output]:\n${assistantMessage}`);

        // Parse Tool Execution
        const actionMatch = assistantMessage.match(/Action:\s*(.+)/i);
        const inputMatch = assistantMessage.match(/Action Input:\s*(.+)/i);
        const finalAnswerMatch = assistantMessage.match(/Final Answer:\s*([\s\S]+)/i);

        if (actionMatch) {
            const action = actionMatch[1].trim();
            const input = inputMatch ? inputMatch[1].trim() : '';

            if (TOOLS[action]) {
                console.log(`⚙️ Executing Tool: ${action}(${input})`);
                const observation = await TOOLS[action](input);
                console.log(`👁️ Observation: ${observation}`);
                
                messages.push({ role: 'user', content: `Observation: ${observation}` });
            } else {
                const errorMsg = `Error: Tool '${action}' does not exist.`;
                console.log(`⚠️ ${errorMsg}`);
                messages.push({ role: 'user', content: `Observation: ${errorMsg}` });
            }
        } 
        else if (finalAnswerMatch) {
            const finalAnswer = finalAnswerMatch[1].trim();
            console.log(`\n✅ [Goal Achieved]: ${finalAnswer}`);
            
            // Automatically broadcast the final answer into the game chat!
            await TOOLS.chat(finalAnswer);
            return;
        } 
        else {
            messages.push({ role: 'user', content: 'Observation: Error - You must output either an Action or a Final Answer.' });
        }
    }
    
    console.log("⚠️ Agent stopped: Reached maximum iterations.");
    await TOOLS.chat("I got confused and had to stop thinking.");
}

// CHAT LISTENER
socket.on('msg', (id, senderName, message) => {
    // Ignore our own messages
    //if (id === me.id) return;
    
    // Only respond if the message starts with "@agent"
    if (message.toLowerCase().startsWith('@agent')) {
        const command = message.substring(6).trim();
        runAgentTurn(command);
    }
});

console.log("🚀 LLM Agent started! Type '@agent <command>' in the DeliverooJS chat.");