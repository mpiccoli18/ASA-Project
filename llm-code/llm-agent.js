import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import OpenAI from 'openai';
import axios from 'axios';
import * as cheerio from 'cheerio';

export default class LLMAgent {
    constructor(emitter) {
        this.teamRadio = emitter; // The walkie-talkie from index.js
        
        this.client = new OpenAI({
            baseURL: process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1',
            apiKey: process.env.LITELLM_API_KEY,
        });
        this.MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
        this.socket = new DjsConnect(process.env.BDI_URL, process.env.LLM_TOKEN);
        
        this.me = { id: null, name: '', x: null, y: null, score: 0 };

        // We bind the tools to 'this' so they can access class properties
        this.TOOLS = {
            get_my_position: async () => {
                if (this.me.x === null || this.me.y === null) return "Error: position not available yet.";
                return `Current state -> X: ${Math.round(this.me.x)}, Y: ${Math.round(this.me.y)}, Score: ${this.me.score}`;
            },
            
            move: async (direction) => {
                const normalized = direction.trim().toLowerCase();
                return new Promise((resolve) => {
                    this.socket.emit('move', normalized, (status) => {
                        if (status) resolve(`Successfully moved ${normalized}.`);
                        else resolve(`Error: Failed to move ${normalized}. There might be a wall or player in the way.`);
                    });
                });
            },

            chat: async (message) => {
                this.socket.emit('say', message);
                return `Successfully broadcasted message: "${message}"`;
            },

            getTemperature: async (location) => {
                try {
                    const geoRes = await axios.get(`https://geocoding-api.open-meteo.com/v1/search?name=${location}&count=1`);
                    if (!geoRes.data.results) return `Error: Could not find coordinates for ${location}.`;
                    const { latitude, longitude } = geoRes.data.results[0];
                    
                    const weatherRes = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
                    const temp = weatherRes.data.current_weather.temperature;
                    return `The current temperature in ${location} is ${temp}°C.`;
                } catch (error) {
                    return `Error fetching weather: ${error.message}`;
                }
            },

            webSearch: async (input) => {
                try {
                    const parts = input.split('|');
                    if (parts.length < 2) return "Error: Input must be formatted as 'URL | query'";
                    
                    const url = parts[0].trim();
                    const query = parts[1].trim();

                    console.log(`🌐 Fetching URL: ${url}`);
                    
                    const response = await axios.get(url);
                    const $ = cheerio.load(response.data);
                    $('script, style, nav, footer').remove(); 
                    const rawText = $('body').text().replace(/\s+/g, ' ').trim();
                    const snippet = rawText.substring(0, 4000);
                    
                    return `Here is the text from the webpage. Please read it and answer this query: "${query}". Webpage text: ${snippet}`;
                } catch (error) {
                    return `Error fetching webpage: ${error.message}`;
                }
            },

            update_team_strategy: async (strategy) => {
                const validStrategies = ['GET_PARCEL', 'DELIVER_PARCEL', 'EXPLORE', 'PAUSE'];
                const upperStrategy = strategy.trim().toUpperCase();
                
                if (validStrategies.includes(upperStrategy)) {
                    this.teamRadio.emit('strategy_change', upperStrategy);
                    return `Successfully commanded Agent A to switch strategy to: ${upperStrategy}`;
                } else {
                    return `Error: Invalid strategy. Must be one of: ${validStrategies.join(', ')}`;
                }
            },
            get_agent_a_status: async () => {
                return new Promise((resolve) => {
                    // Ping Agent A over the radio and wait for a callback
                    this.teamRadio.emit('request_status', (statusData) => {
                        if (!statusData) {
                            resolve("Error: Could not reach Agent A.");
                            return;
                        }
                        const msg = `Agent A is currently at X:${statusData.x}, Y:${statusData.y}. Current task: ${statusData.intention}. It currently sees ${statusData.parcelsKnown} parcels on the map.`;
                        resolve(msg);
                    });
                });
            },
            send_agent_a_to: async (coordinates) => {
                const parts = coordinates.split(',');
                if (parts.length !== 2) return "Error: Input must be exactly in 'x, y' format.";
                
                const x = parseInt(parts[0].trim());
                const y = parseInt(parts[1].trim());
                
                return new Promise((resolve) => {
                    this.teamRadio.emit('go_to', { x, y });
                    resolve(`Success: Commanded Agent A to immediately navigate to X:${x}, Y:${y}.`);
                });
            },
            pickup: async () => {
                return new Promise((resolve) => {
                    this.socket.emit('pickup', (parcelsAffected) => {
                        const ids = Array.isArray(parcelsAffected) ? parcelsAffected.map(p => p.id) : [];
                        if (ids.length > 0) resolve(`Success: Picked up parcels: ${ids.join(', ')}`);
                        else resolve(`Error: Failed to pick up. There is no parcel here, or you are already full.`);
                    });
                });
            },

            putdown: async () => {
                return new Promise((resolve) => {
                    this.socket.emit('putdown', () => {
                        resolve(`Successfully dropped all carried parcels at current location.`);
                    });
                });
            },
        };

        this.SYSTEM_PROMPT = `You are an AI assistant controlling a robot in the DeliverooJS game, and you are the team captain of Agent A.
        
        Available tools you can use:
        - get_my_position(): Returns your own current X and Y coordinates, and your current score. Takes no input.
        - move(direction): Moves your robot one step. Valid inputs: up, down, left, right.
        - chat(message): Broadcasts a message back to the global game chat.
        - update_team_strategy(strategy): Commands your BDI teammate (Agent A) to change behavior. Valid inputs: GET_PARCEL, DELIVER_PARCEL, EXPLORE, PAUSE.
        - getTemperature(location): Fetches real-time weather temperature for any city or location name. Input format: Just the city name (e.g., Rome, Trento).
        - webSearch(input): Searches the web by scraping a page. Input MUST be formatted exactly as: URL | query (e.g., https://en.wikipedia.org/wiki/Trento | summary).
        - get_agent_a_status(): Asks Agent A for its current coordinates, its active task, and how many parcels it sees. Use this when the user asks about Agent A.
        - send_agent_a_to(coordinates): Commands Agent A to navigate to a specific X,Y map coordinate. Input MUST be formatted as "x, y" (e.g., 15, 15).
        - pickup(): Attempts to pick up a parcel on your exact current tile. Takes no input.
        - putdown(): Drops all parcels you are currently holding onto your current tile. Takes no input.

        If you need to use a tool, output ONLY in this exact format:
        Thought: <your brief reasoning about why you are calling this tool>
        Action: <exact tool name from the list above>
        Action Input: <the specific input required for that tool>

        If you have completely finished the user's request, collected all data, or no tool is needed, output ONLY in this format:
        Final Answer: <your final response or answer to the user>`;
    }

    async runAgentTurn(userInput, maxIterations = 50) {
        let messages = [
            { role: 'system', content: this.SYSTEM_PROMPT },
            { role: 'user', content: userInput }
        ];

        console.log(`\n🗣️ Request received: "${userInput}"`);

        for (let i = 0; i < maxIterations; i++) {
            const response = await this.client.chat.completions.create({
                model: this.MODEL,
                messages: messages,
                temperature: 0.1, 
            });

            const assistantMessage = response.choices[0].message.content.trim();
            messages.push({ role: 'assistant', content: assistantMessage });
            console.log(`\n🤖 [LLM Output]:\n${assistantMessage}`);

            const actionMatch = assistantMessage.match(/Action:\s*(.+)/i);
            const inputMatch = assistantMessage.match(/Action Input:\s*(.+)/i);
            const finalAnswerMatch = assistantMessage.match(/Final Answer:\s*([\s\S]+)/i);

            if (actionMatch) {
                const action = actionMatch[1].trim();
                const input = inputMatch ? inputMatch[1].trim() : '';

                if (this.TOOLS[action]) {
                    console.log(`⚙️ Executing Tool: ${action}(${input})`);
                    const observation = await this.TOOLS[action](input);
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
                
                await this.TOOLS.chat(finalAnswer);
                return;
            } 
            else {
                messages.push({ role: 'user', content: 'Observation: Error - You must output either an Action or a Final Answer.' });
            }
        }
        
        console.log("⚠️ Agent stopped: Reached maximum iterations.");
        await this.TOOLS.chat("I got confused and had to stop thinking.");
    }

    start() {
        this.socket.on('you', (you) => { 
            this.me = you; 
        });
        
        this.socket.on('msg', (...args) => {
            // Grab the actual message text safely, no matter how the server formats it
            let text = "";
            
            // If the server sends (id, senderName, message)
            if (args.length === 3 && typeof args[2] === 'string') {
                text = args[2];
            } 
            // If the server sends a single object (msgObject)
            else if (args.length === 1 && typeof args[0] === 'object') {
                text = args[0].msg || args[0].text || args[0].message || "";
            } 
            // If the server sends (senderName, message)
            else if (args.length === 2 && typeof args[1] === 'string') {
                text = args[1];
            }

            // Only process if we actually extracted a string
            if (typeof text === 'string' && text.toLowerCase().startsWith('@agent')) {
                console.log(`\n💬 [CHAT WAKE WORD DETECTED] Processing command...`);
                const command = text;
                this.runAgentTurn(command);
            }
        });

        console.log("🚀 LLM Agent started! Type '@agent <command>' in the chat.");
    }
}