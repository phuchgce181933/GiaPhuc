'use strict';
const mongoose = require('mongoose');
const env = require('../../config');
const { connectPresentationDB } = require('../../config/db');
const { Schema } = mongoose;
const slideSchema = new Schema({ title: {type:String,required:true,maxlength:255}, content:{type:String,required:true,maxlength:4000}, notes:{type:String,default:'',maxlength:4000} }, {_id:false});
const presentationSchema = new Schema({ ownerId:{type:String,required:true,index:true}, title:{type:String,required:true,maxlength:255}, sourceContent:{type:String,required:true,maxlength:50000}, language:String, audience:String, slideCount:Number, style:String, outline:{type:[slideSchema],default:[]}, status:{type:String,enum:['draft','generating_outline','ready','creating','completed','failed'],default:'draft',index:true}, error:{type:String,default:''}, canvaDesignId:String, canvaViewUrl:String, canvaEditUrl:String, canvaJobId:String, exportUrls:{type:Map,of:String,default:undefined}, canvaRefreshToken:{type:String,select:false}, canvaTokenExpiresAt:Date, createIdempotencyKey:{type:String,index:true} }, {timestamps:true,versionKey:false});
presentationSchema.index({ownerId:1,createdAt:-1});
let Presentation;
async function getPresentationModel(){ const connection=await connectPresentationDB(); if(!Presentation) { Presentation=connection.model('Presentation',presentationSchema); await Presentation.init(); } return Presentation; }
module.exports={getPresentationModel,presentationSchema};
