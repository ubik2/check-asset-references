# Github Action: Check References

A GitHub Action that checks that the JSON files referenced in a CSV exist, and that the media files referenced in those JSON files exist.

## Usage

### Inputs

- `activities_csv`: Relative file path under the repository of the CSV file to check for task references. Default is: `'./activities.csv'`.
- `articles_csv`: Relative file path under the repository of the CSV file to check for article references. Default is: `'./articles.csv'`.
- `magic_tasks`: One or more relative file paths under the repository (seperated by comma) of the JSON files to validate with the schema provided.
- `git_base_sha`: Optional git hash indicating the base of a pull request.
- `git_head_sha`: Optional git hash indicating the head of a pull request.

### Example Workflow

An example `.github/workflows/validate.yml` workflow to run JSON validation on the repository:

```yaml
name: Validate Assets

on: [pull_request]

jobs:
  validate-assets:
    runs-on: ubuntu-latest
    steps:
      - id: check-references
        uses: ubik2/check-references-action@0.1.0
        with:
          activities_csv: activities.csv
          articles_csv: articles_csv
          magic_tasks: tasks/activity_set_step_goal.json,tasks/permission_sleeps.json,tasks/permission_steps.json,tasks/profile_licenses.json
```
