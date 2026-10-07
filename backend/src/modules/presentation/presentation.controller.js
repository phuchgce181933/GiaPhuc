'use strict';
const service = require('./presentation.service');
const { createSchema, updateSchema, exportSchema } = require('./presentation.validation');
const ApiError = require('../../shared/ApiError');
const catchAsync = require('../../shared/catchAsync');
function parse(schema, value) { const r = schema.safeParse(value); if (!r.success) throw ApiError.unprocessable('Dữ liệu không hợp lệ.', { issues: r.error.issues }); return r.data; }
async function list(req,res) { res.json({ success:true, data: await service.list(req.user.id) }); }
async function create(req,res) { const input=parse(createSchema, req.body); res.status(202).json({ success:true, data: await service.outline(req.user.id,input) }); }
async function update(req,res) { res.json({ success:true, data: await service.update(req.user.id, req.params.id, parse(updateSchema, req.body)) }); }
async function connect(req,res) { res.json({ success:true, data:{ authorizationUrl: service.oauthStart(req.user.id) } }); }
async function callback(req,res) { await service.oauthCallback(req.query.code, req.query.state); res.redirect(`${require('../../config').FRONTEND_URL}/presentations?canva=connected`); }
async function createCanva(req,res) { res.status(202).json({ success:true, data: await service.createOnCanva(req.user.id, req.params.id, req.get('Idempotency-Key')) }); }
async function exportFile(req,res) { res.json({ success:true, data: await service.exportDesign(req.user.id, req.params.id, parse(exportSchema, req.body).format) }); }
async function detail(req,res) { res.json({ success:true, data: await service.getOwned(req.user.id, req.params.id) }); }
module.exports = Object.fromEntries(Object.entries({ list, create, update, connect, callback, createCanva, exportFile, detail }).map(([name, handler]) => [name, catchAsync(handler)]));
