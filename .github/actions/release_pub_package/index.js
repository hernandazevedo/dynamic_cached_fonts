import core from '@actions/core'
import exec from '@actions/exec'
import github from '@actions/github'
import tc from '@actions/tool-cache'
import auth from '@octokit/auth-action'
import rest from '@octokit/rest'
import parseChangelog from 'changelog-parser'
import fs from 'fs'

// Latest Stable Flutter Version (at the time of release) that support all required features.

const flutterWinDownloadUrl = 'https://storage.googleapis.com/flutter_infra/releases/stable/windows/flutter_windows_2.0.3-stable.zip'
const flutterMacOSDownloadUrl = 'https://storage.googleapis.com/flutter_infra/releases/stable/macos/flutter_macos_2.0.3-stable.zip'
const flutterLinuxDownloadUrl = 'https://storage.googleapis.com/flutter_infra/releases/stable/linux/flutter_linux_2.0.3-stable.tar.xz'

async function run() {
   const octokit = await setUpGithubAuth()

   // Get inputs from workflow

   const inputs = await getActionInputs(octokit)

   // Get Changelog file path

   const changelogFile = inputs.changelogFilePath || `${process.env.GITHUB_WORKSPACE}/CHANGELOG.md`

   // Get latest version and release notes from changelog

   addFakeChangelogHeading(changelogFile)

   let version, body

   parseChangelog(changelogFile, (_, changelog) => {
      version = changelog.versions[0].version
      body = changelog.versions[0].body
   })

   // Check if latest version in changelog has already been released

   if (version === inputs.previousVersion) {
      core.setFailed(
         `No new version found. Latest version in Changelog (${version}) is the same as the previous version.`
      )
   }

   // Create a release

   await createRelease(octokit, {
      preReleaseScript: inputs.preReleaseScript,
      postReleaseScript: inputs.postReleaseScript,
      isDraft: inputs.isDraft,
      version: version,
      body: body
   })

   // Set up the Flutter SDK

   await setUpFlutterSDK()

   // Setup auth for pub

   setUpPubAuth({
      accessToken: inputs.accessToken,
      refreshToken: inputs.refreshToken,
      idToken: inputs.idToken,
      tokenEndpoint: inputs.tokenEndpoint,
      expiration: inputs.expiration
   })

   // Publish package

   await publishPackageToPub({
      prePublishScript: inputs.prePublishScript,
      postPublishScript: inputs.postPublishScript,
      shouldRunPubScoreTest: inputs.shouldRunPubScoreTest,
      pubScoreMinPoints: inputs.pubScoreMinPoints
   })
}

run()

// Helper functions

async function setUpGithubAuth() {
   const authentication = auth.createActionAuth()

   return new rest.Octokit({
      auth: await authentication()
   })
}

async function getActionInputs(octokit) {
   const inputs = {}

   try {
      inputs.previousVersion = core.getInput('previous-version') || await getLatestReleaseVersion(octokit)

      inputs.changelogFilePath = core.getInput('changelog-file')

      inputs.isDraft = core.getInput('is-draft').toUpperCase() === 'TRUE'

      inputs.preReleaseScript = core.getInput('pre-release-script')
      inputs.postReleaseScript = core.getInput('post-release-script')

      inputs.prePublishScript = core.getInput('pre-publish-script')
      inputs.postPublishScript = core.getInput('post-publish-script')

      inputs.shouldRunPubScoreTest = core.getInput('should-run-pub-score-test').toUpperCase() === 'TRUE'
      inputs.pubScoreMinPoints = Number.parseInt(core.getInput('pub-score-min-points'))

      inputs.accessToken = core.getInput('access-token', { required: true })
      inputs.refreshToken = core.getInput('refresh-token', { required: true })
      inputs.idToken = core.getInput('id-token', { required: true })
      inputs.tokenEndpoint = core.getInput('token-endpoint', { required: true })
      inputs.expiration = core.getInput('expiration', { required: true })
   } catch (err) {
      core.setFailed(err)
   }

   return inputs
}

async function getLatestReleaseVersion(octokit) {
   const repo = github.context.repo

   const releases = await octokit.repos.listReleases({
      owner: repo.owner,
      repo: repo.repo
   })

   return releases.data[0].tag_name.replace('v', '')
}

function addFakeChangelogHeading(changelogFile) {
   const data = fs.readFileSync(changelogFile)
   const fd = fs.openSync(changelogFile, 'w+')
   const buffer = Buffer.from('# Fake Heading\n\n')

   fs.writeSync(fd, buffer, 0, buffer.length, 0) // write new data

   fs.appendFileSync(changelogFile, data) // append old data

   fs.closeSync(fd)
}

function getCommand(commandScript) {
   const commandAndArgs = commandScript.split(' ')

   return {
      commandLine: commandAndArgs[0],
      args: commandAndArgs.slice(1)
   }
}

async function createRelease(octokit, {
   preReleaseScript, postReleaseScript, isDraft, version, body
}) {
   const preReleaseCommand = getCommand(preReleaseScript)
   const postReleaseCommand = getCommand(postReleaseScript)
   const repo = github.context.repo

   await exec.exec(preReleaseCommand.commandLine, preReleaseCommand.args)

   await (await octokit).repos.createRelease({
      owner: repo.owner,
      repo: repo.repo,
      tag_name: `v${version}`,
      target_commitish: github.context.sha,
      body: body,
      draft: isDraft,
      prerelease: version.contains('-')
   })

   await exec.exec(postReleaseCommand.commandLine, postReleaseCommand.args)
}

async function setUpFlutterSDK() {
   core.exportVariable('FLUTTER_ROOT', `${process.env.HOME}/flutter`)

   const toolLocation = tc.find('flutter', '2.x') || process.env.FLUTTER_ROOT

   if (process.platform === 'win32') {
      const flutterPath = await tc.downloadTool(flutterWinDownloadUrl)
      await tc.extractZip(flutterPath, process.env.FLUTTER_ROOT)

      tc.cacheDir(process.env.FLUTTER_ROOT, 'flutter', '2.0.3')
   } else if (process.platform === 'darwin') {
      const flutterPath = await tc.downloadTool(flutterMacOSDownloadUrl)
      await tc.extractZip(flutterPath, process.env.FLUTTER_ROOT)

      tc.cacheDir(process.env.FLUTTER_ROOT, 'flutter', '2.0.3')
   } else {
      const flutterPath = await tc.downloadTool(flutterLinuxDownloadUrl)
      await tc.extractTar(flutterPath, process.env.FLUTTER_ROOT)

      tc.cacheDir(process.env.FLUTTER_ROOT, 'flutter', '2.0.3')
   }

   core.addPath(`${toolLocation}/bin/flutter`)
}

async function publishPackageToPub({
   prePublishScript,
   postPublishScript,
   shouldRunPubScoreTest,
   pubScoreMinPoints
}) {
   const prePublishCommand = getCommand(prePublishScript)
   const postPublishCommand = getCommand(postPublishScript)

   await exec.exec(prePublishCommand.commandLine, prePublishCommand.args)

   await runPanaTest({ shouldRunPubScoreTest: shouldRunPubScoreTest, pubScoreMinPoints: pubScoreMinPoints })

   await exec.exec('flutter', ['pub', 'publish', '--force'])

   await exec.exec(postPublishCommand.commandLine, postPublishCommand.args)
}

async function runPanaTest({ shouldRunPubScoreTest, pubScoreMinPoints }) {
   if (shouldRunPubScoreTest) {
      let panaOutput

      await exec.exec('flutter', ['pub', 'global', 'activate', 'pana'])

      await exec.exec('flutter', ['pub', 'global', 'run', 'pana', process.env.GITHUB_WORKSPACE, '--json', '--no-warning'], {
         listeners: {
            stdout: data => { panaOutput += data.toString() }
         }
      })

      const resultArr = panaOutput.split(/\r?\n/)

      const panaResult = JSON.parse(resultArr[resultArr.length - 1])

      if (isNaN(pubScoreMinPoints)) core.setFailed('run-pub-score-test was set to true but no value for pub-score-min-points was provided')

      if (panaResult.scores.grantedPoints < pubScoreMinPoints) {
         for (const test in panaResult.report.sections) {
            if (test.status !== 'passed') core.warning(test.title + '\n\n\n' + test.summary)
         }
         core.error('Pub score test failed')
      }
   }
}

function setUpPubAuth({
   accessToken,
   refreshToken,
   idToken,
   tokenEndpoint,
   expiration
}) {
   const credentials = {
      accessToken: accessToken,
      refreshToken: refreshToken,
      idToken: idToken,
      tokenEndpoint: tokenEndpoint,
      scopes: [
         'https://www.googleapis.com/auth/userinfo.email',
         'openid'
      ],
      expiration: expiration
   }

   if (process.platform === 'win32') fs.writeFileSync(`${process.env.APPDATA}/Pub/Cache/credentials.json`, credentials)
   else fs.writeFileSync(`${process.env.HOME}/.pub-cache/credentials.json`, JSON.stringify(credentials))
}
