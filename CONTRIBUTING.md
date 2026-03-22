# Contributing to Azure PostgreSQL Agent Memory

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Run type checking: `npm run lint`
4. Start the worker in dev mode: `npm run worker:dev`

## Pull Request Process

1. Ensure your code compiles cleanly (`npm run lint`)
2. Update documentation if you change any user-facing behavior
3. Follow the existing code style and conventions
4. Keep PRs focused — one feature or fix per PR

## Reporting Issues

Use [GitHub Issues](https://github.com/msftse/azure-pg-agent-mem/issues) to report bugs or suggest features. Include:

- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Node.js version and operating system
- Relevant logs (set `AGENT_MEM_LOG_LEVEL=DEBUG` for verbose output)
