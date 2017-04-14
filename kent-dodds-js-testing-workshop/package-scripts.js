const path = require('path')
const {
  concurrent,
  series,
  runInNewWindow,
  crossEnv,
  rimraf,
  commonTags,
  ifWindows,
} = require('nps-utils')

const {oneLine} = commonTags

const delay = s => ifWindows(`timeout ${s}`, `sleep ${s}`)
const ignoreOutput = s =>
  `echo ${s} && ${s} ${ifWindows('> NUL', '&>/dev/null')}`

const splitVerifyDescription = oneLine`
  This verifies that the final version actually passes the tests.
  To do this, we first use split-guide and place the final version
  in the place of the exercises, then we run the tests, then
  we re-run the split to have the exercises where they should be.
`

module.exports = {
  scripts: {
    default: concurrent.nps('mongo', 'api', 'client'),
    separateStart: {
      description: 'Runs all the start scripts in individual terminals',
      script: series(
        runInNewWindow.nps('mongo'),
        runInNewWindow.nps('api'),
        runInNewWindow.nps('client')
      ),
    },
    mongo: {
      script: series('mkdirp .mongo-db', ignoreOutput('nps mongo.start')),
      start: `mongod --dbpath "${path.join(__dirname, './.mongo-db')}"`,
      description: 'Create the .mongo-db dir and start the mongod process',
      stop: 'mongo admin --eval "db.shutdownServer()"',
    },
    api: {
      script: series('cd api', 'npm start --silent'),
      description: 'start the api server',
      test: {
        script: concurrent.nps('api.test.unit', 'api.test.integration'),
        description: 'run the api tests',
        unit: series('cd api', 'npm start test.unit --silent'),
        integration: oneLine`
          concurrently
          --kill-others
          --success first
          --prefix "[{name}]"
          --names dev.mongo,dev.api,api.test.integration
          "nps dev.mongo"
          "${delay(2)} && cd api && npm start --silent test.integration"
        `,
      },
    },
    client: {
      script: series('cd client', 'npm start --silent -- "default 8080"'),
      description: 'start the client server',
      test: {
        script: series('cd client', 'npm test --silent'),
        description: 'run the client tests',
      },
    },
    build: {
      default: concurrent.nps('build.api', 'build.client'),
      api: series('cd api', 'npm start build --silent'),
      client: series('cd client', 'npm start build --silent'),
    },
    dev: {
      description: 'starts everything in dev mode',
      script: concurrent.nps('dev.mongo', 'dev.client', 'dev.api'),
      separate: {
        description: 'Runs all of the dev scripts in individual terminals',
        script: series(
          runInNewWindow.nps('dev.mongo --silent'),
          runInNewWindow.nps('npm start dev.client --silent'),
          runInNewWindow.nps('dev.api --silent')
        ),
      },
      // dev is the same as live for mongo for now...
      mongo: 'npm start mongo --silent',
      client: series('cd client', 'npm start dev --silent'),
      api: series('cd api', 'npm start dev --silent'),
    },
    e2e: getE2EScripts(),
    test: {
      description: 'run the tests in parallel',
      script: concurrent.nps('api.test', 'client.test'),
    },
    lint: {
      script: 'eslint .',
      description: 'lint project files',
    },
    format: {
      script: 'prettier-eslint --write "api/**/*.js" "client/**/*.js"',
      description: 'autoformat project files',
    },
    validate: {
      script: concurrent.nps(
        'lint',
        'split.api.verify',
        'split.client.verify',
        'e2e'
      ),
      description: 'validates that things are set up properly',
    },
    split: {
      default: concurrent.nps('split.api', 'split.client'),
      verify: concurrent.nps('split.api.verify', 'split.client.verify'),
      client: {
        default: series(
          rimraf('client-final'),
          oneLine`
            split-guide generate
            --no-clean
            --templates-dir templates/client
            --exercises-dir client
            --exercises-final-dir client-final
          `
        ),
        verify: {
          description: splitVerifyDescription,
          script: series(
            rimraf('client-final', 'node_modules/.tmp/client'),
            oneLine`
              split-guide generate
              --no-clean
              --templates-dir templates/client
              --exercises-dir node_modules/.tmp/client
              --exercises-final-dir client
            `,
            'nps client.test',
            series('cd client', 'npm start demo', 'cd ..'),
            'nps split.client'
          ),
        },
      },
      api: {
        default: series(
          rimraf('api-final'),
          oneLine`
            split-guide generate
            --no-clean
            --templates-dir templates/api
            --exercises-dir api
            --exercises-final-dir api-final
          `
        ),
        verify: {
          description: splitVerifyDescription,
          script: series(
            rimraf('api-final', 'node_modules/.tmp/api'),
            oneLine`
              split-guide generate
              --no-clean
              --templates-dir templates/api
              --exercises-dir node_modules/.tmp/api
              --exercises-final-dir api
            `,
            'nps api.test',
            series('cd api', 'npm start demo', 'cd ..'),
            'nps split.api'
          ),
        },
      },
    },
    contributors: {
      add: {
        description: oneLine`
          Prompt to add a new contributor
          to the contributors table
        `,
        script: 'all-contributors add',
      },
      generate: {
        description: 'regenerates the contributors table',
        script: 'all-contributors generate',
      },
    },
  },
}

function getE2EScripts() {
  const allScripts = ['client', 'cypress', 'mongo', 'api']
  const cypresslessScripts = allScripts.filter(x => x !== 'cypress')
  const devMap = s => `"${crossEnv(`STDIO=inherit nps e2e.dev.${s}`)}"`
  const runMap = s => `"nps e2e.run.${s}"`

  const {run, dev} = allScripts.reduce(
    (runDev, scriptName) => {
      const script = `node ./scripts/e2e-${scriptName}`
      runDev.run[scriptName] = script
      runDev.dev[scriptName] = crossEnv(`E2E_DEV=true ${script}`)
      return runDev
    },
    {run: {}, dev: {}}
  )
  const defaultScript = getDefaultScript(
    allScripts,
    runMap,
    '--kill-others --success first'
  )

  const loadDatabase = crossEnv(
    oneLine`
      MONGO_PORT=27018
      MONGO_PATH=./.e2e/mongo-db
      MONGODB_URI="mongodb://localhost:27018/conduit"
      node ./scripts/load-database.js
    `
  )

  Object.assign(dev, {
    default: getConcurrentScript(allScripts, devMap),
    services: {
      description: oneLine`
        starts all the services.
        Use if you already have cypress running
      `,
      script: getConcurrentScript(cypresslessScripts, devMap),
    },
  })

  const noBuild = getBuildessScript(
    allScripts,
    runMap,
    '--kill-others --success first'
  )

  return {
    default: {
      script: defaultScript,
      description: oneLine`
        Runs everything you need for a full E2E test run.
        Note that there are various combinations of these
        scripts which you can run. See the child scripts
        of e2e. Also note that if you specify the
        environment variable of \`STDIO=inherit\`, you will
        be able to see the output of services which could
        bet quite handy.
      `,
    },
    loadDatabase,
    run,
    dev,
    noBuild,
  }

  function getDefaultScript(scripts, prefix, flags = '') {
    const prepare = concurrent.nps('e2e.loadDatabase', 'build')
    return series(prepare, getConcurrentScript(scripts, prefix, flags))
  }

  function getBuildessScript(scripts, prefix, flags) {
    return series(
      'nps e2e.loadDatabase',
      getConcurrentScript(scripts, prefix, flags)
    )
  }

  function getConcurrentScript(scripts, map, flags = '') {
    const npsScripts = scripts.map(map)

    return oneLine`
      concurrently
      ${flags}
      --prefix-colors "bgGreen.bold,bgBlue.bold,bgMagenta.bold,bgCyan.bold"
      --prefix "[{name}]"
      --names "${scripts.join(',')}"
      ${npsScripts.join(' ')}
    `
  }
}

// this is not transpiled
/*
  eslint
  comma-dangle: [
    2,
    {
      arrays: 'always-multiline',
      objects: 'always-multiline',
      functions: 'never'
    }
  ]
 */
