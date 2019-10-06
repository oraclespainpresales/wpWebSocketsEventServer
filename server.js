'use strict';

// Module imports
var restify = require('restify')
  , queue = require('block-queue')
  , express = require('express')
  , http = require('http')
  , https = require('https')
  , bodyParser = require('body-parser')
  , fs = require("fs")
  , async = require('async')
  , _ = require('lodash')
  , log = require('npmlog-ts')
  , commandLineArgs = require('command-line-args')
  , getUsage = require('command-line-usage')
  , cors = require('cors')
;

// Instantiate classes & servers
const wsURI       = '/socket.io'
    , restURI     = '/event/:eventname';
var restapp       = express()
  , restserver    = http.createServer(restapp)
;

// ************************************************************************
// Main code STARTS HERE !!
// ************************************************************************

log.stream = process.stdout;
log.timestamp = true;

//const SSLPATH = '/u01/ssl';
const SSLPATH = '/Users/ccasares/Documents/Oracle/Presales/Initiatives/Wedo/setup/wedoteam.io.certificate';

const optionsSSL = {
  cert: fs.readFileSync(SSLPATH + "/certificate.fullchain.crt").toString(),
  key: fs.readFileSync(SSLPATH + "/certificate.key").toString()
};

// Main handlers registration - BEGIN
// Main error handler
process.on('uncaughtException', function (err) {
  log.info("","Uncaught Exception: " + err);
  log.info("","Uncaught Exception: " + err.stack);
});
// Detect CTRL-C
process.on('SIGINT', function() {
  log.info("","Caught interrupt signal");
  log.info("","Exiting gracefully");
  process.exit(2);
});
// Main handlers registration - END

// Initialize input arguments
const optionDefinitions = [
  { name: 'dbhost', alias: 'd', type: String },
  { name: 'pinginterval', alias: 'i', type: Number },
  { name: 'pingtimeout', alias: 't', type: Number },
  { name: 'help', alias: 'h', type: Boolean },
  { name: 'verbose', alias: 'v', type: Boolean, defaultOption: false }
];

const sections = [
  {
    header: 'WEDO Pong Demo - WebSockets Event Server',
    content: 'WebSockets Event Server for WEDO Pong Demo events'
  },
  {
    header: 'Options',
    optionList: [
      {
        name: 'dbhost',
        typeLabel: '[underline]{ipaddress:port}',
        alias: 'd',
        type: String,
        description: 'DB setup server IP address/hostname and port'
      },
      {
        name: 'pinginterval',
        typeLabel: '[underline]{milliseconds}',
        alias: 'i',
        type: Number,
        description: 'Ping interval in milliseconds for event clients'
      },
      {
        name: 'pingtimeout',
        typeLabel: '[underline]{milliseconds}',
        alias: 't',
        type: Number,
        description: 'Ping timeout in milliseconds for event clients'
      },
      {
        name: 'verbose',
        alias: 'v',
        description: 'Enable verbose logging.'
      },
      {
        name: 'help',
        alias: 'h',
        description: 'Print this usage guide.'
      }
    ]
  }
]
var options = undefined;

try {
  options = commandLineArgs(optionDefinitions);
} catch (e) {
  console.log(getUsage(sections));
  console.log(e.message);
  process.exit(-1);
}

if (!options.dbhost) {
  console.log(getUsage(sections));
  process.exit(-1);
}

if (options.help) {
  console.log(getUsage(sections));
  process.exit(0);
}

log.level = (options.verbose) ? 'verbose' : 'info';

const pingInterval = options.pinginterval || 25000
    , pingTimeout  = options.pingtimeout  || 60000
    , PORT = 11200
    , URI = '/ords/pdb1/wedopong/api/demozones'
;

// REST engine initial setup
restapp.use(bodyParser.urlencoded({ extended: true }));
restapp.use(bodyParser.json());
restapp.use(cors());

var client = restify.createJsonClient({
  url: 'https://' + options.dbhost,
  rejectUnauthorized: false,
  headers: {
    "content-type": "application/json"
  }
});

var demozones = _.noop();
var servers = [];

async.series([
    (next) => {
      client.get(URI, (err, req, res, obj) => {
        var jBody = JSON.parse(res.body);
        if (err) {
          next(err.message);
        } else if (!jBody.items || jBody.items.length == 0) {
          next("No demozones found. Aborting.");
        } else {
          demozones = jBody.items;
          next(null);
        }
      });
    },
    (next) => {
      async.eachSeries(demozones, (demozone,callback) => {
        var d = {
          demozone: demozone.id,
          name: demozone.demozone,
          portSSL: demozone.port + PORT
        };
        d.app = express();
        d.serverSSL = https.createServer(optionsSSL, d.app);
        d.ioSSL = require('socket.io')(d.serverSSL, {'pingInterval': pingInterval, 'pingTimeout': pingTimeout});
        const f_connection = (socket) => {
          log.info(d.name,"Connected!!");
          socket.conn.on('heartbeat', () => {
            log.verbose(d.name,'heartbeat');
          });
          socket.on('event', (data) => {
            log.info(d.name,"Event received: " + data);
          });
          socket.on('disconnect', () => {
            log.info(d.name,"Socket disconnected");
          });
          socket.on('error', (err) => {
            log.error(d.name,"Error: " + err);
          });
        };
        d.ioSSL.on('connection', f_connection);
        d.serverSSL.listen(d.portSSL, () => {
          log.info("","Created WSS server for demozone '" + d.name + "' at port: " + d.portSSL);
          servers.push(d);
          callback(null);  
        });
      }, (err) => {
        next(null);
      });
    },
    (next) => {
      restserver.listen(PORT, () => {
        log.info("","REST server running on http://localhost:" + PORT + restURI);
        next(null);
      });
    }
], (err, results) => {
  if (err) {
    log.error("", err.message);
    process.exit(2);
  }
});

restapp.post(restURI, (req,res) => {
  res.status(204).send();
//  log.verbose("","Request: " + JSON.stringify(req.body));
  if (req.params.eventname) {
    // find out the demozone
    if (!req.body[0].payload.data.data_demozone) {
      log.error("", "No {payload.data.data_demozone} structure found in payload: " + JSON.stringify(req.body));
      return;
    }
    var demozone  = req.body[0].payload.data.data_demozone.toUpperCase();
    var server = _.find(servers, { 'demozone': demozone });
    if (server) {
//      var namespace = demozone.toLowerCase() + "," + req.params.eventname;
      var namespace = req.params.eventname;
      log.verbose("","Sending %d event(s) to %s (%s, %d)", req.body.length, namespace, demozone, server.port);
      server.io.sockets.emit(namespace, req.body);
      server.ioSSL.sockets.emit(namespace, req.body);
    } else {
      log.error("", "Request received for a demozone not registered (" + demozone + ")");
    }
  }
});
