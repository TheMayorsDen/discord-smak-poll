==> Deploying...
==> Setting WEB_CONCURRENCY=1 by default, based on available CPUs in the instance
0.options[3][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
0.options[4][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
0.options[5][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
0.options[6][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
0.options[7][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
0.options[8][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
0.options[9][APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID]: Required options must be placed before non-required options
    at handleErrors (/opt/render/project/src/node_modules/@discordjs/rest/dist/index.js:791:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async SequentialHandler.runRequest (/opt/render/project/src/node_modules/@discordjs/rest/dist/index.js:1198:23)
    at async SequentialHandler.queueRequest (/opt/render/project/src/node_modules/@discordjs/rest/dist/index.js:1029:14)
    at async _REST.request (/opt/render/project/src/node_modules/@discordjs/rest/dist/index.js:1342:22)
    at async registerCommands (/opt/render/project/src/index.js:929:1)
    at async Client.<anonymous> (/opt/render/project/src/index.js:951:1) {
  rawError: {
    message: 'Invalid Form Body',
    code: 50035,
    errors: { '0': [Object] }
  },
  code: 50035,
  status: 400,
  method: 'PUT',
  url: 'https://discord.com/api/v10/applications/1352303093999603802/guilds/1282373300193984525/commands',
  requestBody: { files: undefined, json: [ [Object], [Object] ] }
}
==> Your service is live 🎉
==> 
==> ///////////////////////////////////////////////////////////
==> 
==> Available at your primary URL https://mayorbot-j6ys.onrender.com
==> 
==> ///////////////////////////////////////////////////////////
==> Detected service running on port 10000
==> Docs on specifying a port: https://render.com/docs/web-services#port-binding
