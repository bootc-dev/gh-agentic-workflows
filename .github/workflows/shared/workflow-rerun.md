---
import-schema:
  expected-event:
    type: choice
    options: [pull_request, merge_group]
    required: true
  monitored-workflow:
    type: string
    required: true
  monitored-workflow-path:
    type: string
    required: true
safe-outputs:
  jobs:
    workflow-rerun:
      description: >-
        Automatically rerun the monitored failed CI workflow after a clearly
        transient infrastructure failure. Choose failed to rerun only failed
        jobs, or all to rerun every job. The target run is derived from this
        workflow's trigger and cannot be selected by the agent.
      runs-on: ubuntu-latest
      permissions:
        actions: read
        contents: read
      inputs:
        scope:
          description: Rerun only failed jobs or every job in the failed workflow run.
          required: true
          type: choice
          options: [failed, all]
          default: failed
        reason:
          description: Brief evidence that the failure is a transient infrastructure problem.
          required: true
          type: string
      output: Rerun request validated and submitted.
      max: 1
      steps:
        - name: Checkout trusted rerun handler
          uses: actions/checkout@v7
          with:
            ref: ${{ github.event.repository.default_branch }}
            token: ${{ github.token }}
            persist-credentials: false
        - name: Generate App token
          id: app-token
          uses: actions/create-github-app-token@v3.2.0
          with:
            client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
            private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
            permission-actions: write
        - name: Validate and rerun monitored workflow
          uses: actions/github-script@v9
          with:
            github-token: ${{ steps.app-token.outputs.token }}
            script: |
              const rerunWorkflow = require(
                `${process.env.GITHUB_WORKSPACE}/.github/workflows/shared/workflow-rerun.cjs`,
              );
              await rerunWorkflow({
                core,
                context,
                expectedEvent: '${{ github.aw.import-inputs.expected-event }}',
                github,
                monitoredWorkflow: '${{ github.aw.import-inputs.monitored-workflow }}',
                monitoredWorkflowPath: '${{ github.aw.import-inputs.monitored-workflow-path }}',
                process,
              });
---
