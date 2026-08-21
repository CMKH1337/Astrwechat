const { app } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
app.setName('WeFlow'); app.setPath('userData',path.join(app.getPath('appData'),'weflow'));
app.whenReady().then(()=>{
 const w=new Worker(path.join(__dirname,'wcdb-probe-worker.cjs'));
 w.on('message',m=>{console.log(JSON.stringify(m)); w.terminate().finally(()=>app.quit());});
 w.on('error',e=>{console.error(e); app.exit(2)});
});
