import 'dotenv/config';
import { EventEmitter } from 'node:events';
import BDIAgent from '../bdi-code/BDIAgent.js';
import LLMAgent from '../llm-code/llm-agent.js'

// Create the central communication channel
const teamRadio = new EventEmitter();

console.log("Starting multi-agent system...");

// Pass the radio to both agents
const agentA = new BDIAgent(teamRadio);
const agentB = new LLMAgent(teamRadio);

// Start them up
agentA.start();
agentB.start();
