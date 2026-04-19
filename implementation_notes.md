# Agentic Task Manager

The goal of this project is to create a CLI tool in python that creates an interface for easily creating agentic workflows and setting them to run on a schedule. It will also house several prompts (I will create these later). 

This project will provide an Agent object that can utilize a logged in Claude Code subscription or logged in Codex CLI to make calls to a model. 

I envision a tool that lets you create an agent with a given name, give it a markdown file with system prompt.

The Agent class will be given a working directory for file I/O, prompt, and skills/MCP/tools. 

There will also be an AgenticWorkflow class that contains a directed graph of operations and optionally a scheduled run time. This AgenticWorkflow should be able to run python scripts, shell scripts, bash commands, as well as Agent objects. This might look like running a python script to get all the To-do tickets on Jira, starting a TicketPlanner agent for each ticket, etc.. It needs to be able to handle a dynamically determined number of Agent objects spinning up. 

The python code for this project MUST be clean production ready code. It needs to be modular and reusable, while still being readable and maintainable. 

Every new piece of functionality must have unit tests. There must also be a regression test that tests everything end to end (at some point). 