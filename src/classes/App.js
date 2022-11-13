const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const rfs = require('rotating-file-stream');
const logger = require('morgan');
const Router = require('./Router');
const Logger = require('../utilities/consoleLog');
const sessions = require('express-session');
require('dotenv').config();
const { makeConnection, executeMysqlQuery } = require('../utilities/mysqlHelper');

// start mysql connection
makeConnection();

let accessLogStream = rfs.createStream('access.log', {
    interval: '1d', // rotate daily
    size: '20M', // rotate when file size exceeds 20 MegaBytes
    compress: "gzip", // compress rotated files
    path: path.join(__dirname, '../..', 'logs/access')
})

class App {
    io;
    server;
    constructor() {
        this.app = express();
        this.server = require('http').createServer(this.app);
        this.app.engine('e', require('ejs').renderFile);
        this.app.set('view engine', 'ejs');
        this.app.set('views', path.join(__dirname, '..', 'views'));
        this.app.use(cors());
        this.app.use(sessions({
            secret: "secure-protagnst-wMYwBT6rcRwEQ8NgJkSLZsJ2d7xgyAhSfja2DJoWow9uRP7qEtT6PurqUo9N",
            saveUninitialized: true,
            cookie: { maxAge: 1000 * 60 * 60 * 24 },
            resave: false
        }));
        this.app.use(cookieParser());
        this.app.use(logger('[:date[iso]] :remote-addr ":referrer" ":user-agent" :method :url :status :res[content-length] - :response-time ms', { stream: accessLogStream }));
        this.app.use(logger(' >> :method :url :status :res[content-length] - :response-time ms'));
        this.app.use(express.json());
        this.app.use(express.urlencoded({
            extended: true
        }));
        this.app.use('/public', express.static(path.join(__dirname, '..', 'public')));
        this.app.use('/docs', express.static(path.join(__dirname, '..', 'docs')))


    }

    async registerRoutes() {
        const filePath = path.join(__dirname, '..', 'routes');
        const files = await fsp.readdir(filePath);
        for await (const file of files) {
            if (file.endsWith('.js')) {
                const router = require(path.join(filePath, file));
                if (router.prototype instanceof Router) {
                    const instance = new router(this);
                    Logger.route(`Route ${instance.path} serving.`);
                    if (instance.auth) {
                        this.app.use(instance.path, this.Authentication, instance.createRoute());
                    } else {
                        this.app.use(instance.path, instance.createRoute());
                    }
                }
            }
        }

        this.app.get('/auth', async function (req, res) {
            if (req.session.email) res.redirect('/');
            else res.render('auth.ejs');
        });

        this.app.get('/', async function (req, res) {
            let session = req.session;
            if (session.email) {
                res.render('home.ejs', {
                    session: req.session
                });
            } else {
                res.redirect('/auth');
            }
        });

        this.app.get('/support', async function (req, res) {
            res.render('support.ejs');
        })

        // this.app.get('/logout', async function (req, res) {
        //     req.session.destroy();
        //     res.redirect('/');
        // });

        // this.app.get('/error', async function (req, res) {
        //     let errorCode = req.query.e;
        //     let reason;
        //     switch (errorCode) {
        //         case "dataNotVerifiable": { reason = "This email cannot be verified"; break; };
        //         case "invalidEmail": { reason = "That is not a valid email"; break; };
        //         case "emailExists": { reason = "This email is already in use."; break; };
        //         default: { reason = "An unknown error ocurred"; break; };
        //     } 
        //     res.render('dataError.ejs', { errorReason: reason })
        // });

        this.app.get('/403', async function (req, res) {
            //give 403 status and render 403.ejs
            res.status(403).render('403.ejs');
        });

        this.app.use((req, res) => {
            res.render('404.ejs');
        });
    }

    async listen(fn) {
        this.server.listen(process.env.EXPRESS_PORT, fn)
    }
}

module.exports = App;