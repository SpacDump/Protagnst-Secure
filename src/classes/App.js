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
const { getFormById } = require('../utilities/formFunctions');
const { checkUserPermissions, getUserBanStatus } = require('../utilities/userFunctions');
const { forceHome } = require('../..');

// start mysql connection
makeConnection();

let accessLogStream = rfs.createStream('access.log', {
    interval: '1d', // rotate daily
    size: '20M', // rotate when file size exceeds 20 MegaBytes
    compress: "gzip", // compress rotated files
    path: path.join(__dirname, '../..', 'logs/access')
});

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

        this.app.use(async function (req, res, next) {
            if (forceHome.includes(req.session.discordId)) {
                forceHome.splice(forceHome.indexOf(req.session.discordId), 1);
                return res.redirect('/');
            };

            if (req.session.isBanned === true) {
                let allowedPages = ['/ban', '/logout', '/support', '/error', '/403', '/404', '/jswarning'];
                if (allowedPages.includes(req.path)) return next();
                else return res.redirect('/ban');
            };

            let dontLogTheseEndpoints = ["/favicon.ico"];
            if (req.session.userId && !dontLogTheseEndpoints.includes(req.path)) await executeMysqlQuery(`INSERT INTO requests (user_id, page, time) VALUES (?, ?, ?)`, [req.session.userId, req.path, Math.floor(Date.now()/1000)]);
            return next();
        });

        this.app.get('/auth', async function (req, res) {
            if (req.session.discordId) return res.redirect('/');
            return res.render('auth.ejs');
        });
        
        this.app.get('/ban', async function (req, res) {
            if (!req.session.discordId || !req.session.isBanned) return res.redirect('/');
            return res.render('userBanned.ejs');
        });

        this.app.get('/', async function (req, res) {
            let session = req.session;

            if (!session.discordId) return res.redirect('/auth');
            let banStatus = await getUserBanStatus(session.discordId);

            if (banStatus) {
                session.isBanned = true;
                return res.redirect('/ban');
            }

            if (!session.mcName || session.mcName === null) return res.redirect('/settings/mc');

            return res.render('home.ejs', { session: session });
        });

        this.app.get('/support', async function (req, res) {
            return res.render('support.ejs');
        });

        this.app.get('/error/:errorCode', async function (req, res) {
            let errorCode = req.params.errorCode;
            let reason;

            switch (errorCode) {
                case "deprecated": { reason = "This page isn't really used anymore."; break; };
                default: { reason = "An unknown error occurred."; break; };
            }

            return res.render('dataError.ejs', { errorReason: reason })
        });

        this.app.get('/403', async function (req, res) {
            return res.status(403).render('403.ejs');
        });

        this.app.get('/jswarning', async function (req, res) {
            if (req.session.discordId) return res.redirect('/');
            return res.render('jswarning.ejs');
        });

        this.app.get('/new', async function (req, res) {
            if (!req.session.discordId) return res.redirect('/auth');
            return res.render('selectNewForm.ejs', { session: req.session });
        });

        this.app.get('/my', async function (req, res) {
            if (!req.session.discordId) return res.redirect('/auth');
            return res.render('selectAvailableSubmission.ejs', { session: req.session });
        });

        this.app.get('/settings', async function (req, res) {
            if (!req.session.discordId) return res.redirect('/auth');

            let totalMemberCount = await executeMysqlQuery(`SELECT COUNT(*) AS total FROM users`);
            if (totalMemberCount.length <= 0) totalMemberCount = 0;
            else totalMemberCount = totalMemberCount[0].total;

            // format number with commas
            totalMemberCount = totalMemberCount.toLocaleString();
            
            return res.render('userSettings.ejs', { session: req.session, totalMemberCount: totalMemberCount });
        });

        this.app.get('/settings/mc', async function (req, res) {
            if (!req.session.discordId) return res.redirect('/auth');
            return res.render('userSetMinecraft.ejs', { session: req.session });
        });

        this.app.get('/view/:submissionId', async function (req, res) {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let submissionId = req.params.submissionId;
            let subData = await executeMysqlQuery(`SELECT * FROM submissions WHERE id = ?`, [submissionId]);
            if (subData.length <= 0) return res.redirect('/404');

            let userPerms = await checkUserPermissions(session.discordId);
            if (subData[0].user_id != session.userId && userPerms <= 2) return res.redirect('/403');

            let formData = await getFormById(subData[0].form_id);
            if (!formData) return res.redirect('/404');

            return res.render('viewSubmission.ejs', {
                session: req.session,
                submissionId: submissionId,
                formName: formData.name
            });
        });

        this.app.get('/stats', async function (req, res) {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPerms = await checkUserPermissions(session.discordId);
            if (userPerms <= 2) return res.redirect('/403');

            return res.render('formStatsAll.ejs', { session: req.session });
        });

        this.app.get('/stats/select', async function (req, res) {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPerms = await checkUserPermissions(session.discordId);
            if (userPerms <= 2) return res.redirect('/403');

            return res.render('formStatsSelect.ejs', {
                session: req.session
            });
        });

        this.app.get('/stats/:formId', async function (req, res) {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let formId = req.params.formId;
            let formData = await getFormById(formId);
            if (!formData) return res.redirect('/404');

            let userPerms = await checkUserPermissions(session.discordId);
            if (userPerms <= 2) return res.redirect('/403');

            return res.render('formStats.ejs', {
                session: req.session,
                formId: formId,
                data: formData
            });
        });

        this.app.get('/graphs', async function (req, res) {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPerms = await checkUserPermissions(session.discordId);  
            if (userPerms <= 2) return res.redirect('/403');

            return res.render('graphView.ejs', { session: req.session });
        });

        this.app.get('/fill/:formId', async (req, res) => {
            // check if user has already applied for this form
            let formId = req.params.formId;
            let session = req.session;
            let discordId = session.discordId;

            if (!discordId) return res.redirect('/auth');

            // check permissions
            // get form from mysql
            let form = await getFormById(formId);
            if (!form) return res.redirect('/404');

            let userPerms = await checkUserPermissions(discordId);

            if (userPerms < form.permissions_needed) {
                return res.redirect('/403');
            };

            return res.render('fill.ejs', {
                formId: form.id,
                formName: form.name,
                session: req.session
            });
        });

        this.app.get('/admin', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission > 2) return res.render('admin.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/admin/view', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission > 2) return res.render('adminView.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/admin/export', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission > 2) return res.render('adminExport.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/admin/export/:id', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission > 2) return res.render('adminExportDL.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/admin/ban', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission > 2) return res.render('adminBan.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/admin/update', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission > 2) return res.render('adminBulkUpdate.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/developer', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission >= 50) return res.render('developer.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/developer/perm', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission >= 50) return res.render('devUpdatePerms.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/developer/form', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission >= 50) return res.render('devCreateForm.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/developer/question', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission >= 50) return res.render('devCreateQuestion.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/developer/vis', async (req, res) => {
            let session = req.session;
            if (!session.discordId) return res.redirect('/auth');

            let userPermission = await checkUserPermissions(req.session.discordId);

            if (userPermission >= 50) return res.render('devChangeFormVis.ejs', { session: req.session });
            else return res.redirect('/403');
        });

        this.app.get('/transparency', async (req, res) => {
            return res.render('transparency.ejs');
        });

        this.app.get('/transparency/deauth', async (req, res) => {
            return res.render('deauth-guide.ejs');
        });

        this.app.get('/credits', async (req, res) => {
            return res.render('credits.ejs');
        });

        this.app.use((req, res) => {
            return res.render('404.ejs');
        });
    }

    async listen(fn) {
        this.server.listen(process.env.EXPRESS_PORT, process.env.EXPRESS_IP, fn)
    }
}

module.exports = App;