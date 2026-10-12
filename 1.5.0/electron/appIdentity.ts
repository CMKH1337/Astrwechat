import { app } from 'electron'
import { join } from 'path'

// Must run before service modules create electron-store instances.
app.setName('WeFlow')
const legacyUserDataPath = join(app.getPath('appData'), 'weflow')
app.setPath('userData', legacyUserDataPath)
process.env.WEFLOW_PROJECT_NAME = 'WeFlow'
process.env.WEFLOW_USER_DATA_PATH = legacyUserDataPath
process.env.WEFLOW_CONFIG_CWD = legacyUserDataPath