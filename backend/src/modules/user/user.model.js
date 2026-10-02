'use strict';

const mongoose = require('mongoose');

const ProfileSchema = new mongoose.Schema(
  {
    fullName: { type: String, default: '', trim: true, maxlength: 120 },
    phone: { type: String, default: '', trim: true, maxlength: 32 },
    dob: { type: Date, default: null },
    gender: {
      type: String,
      enum: ['male', 'female', 'other', ''],
      default: '',
    },
    address: { type: String, default: '', trim: true, maxlength: 500 },
    avatarUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  },
  { _id: false }
);

const STATUS = Object.freeze(['active', 'inactive', 'locked']);

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email'],
    },
    username: { type: String, default: '', trim: true, lowercase: true, maxlength: 64 },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: STATUS, default: 'active', index: true },
    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
    profile: { type: ProfileSchema, default: () => ({}) },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

UserSchema.methods.toClientJSON = function toClientJSON() {
  const obj = this.toObject ? this.toObject() : { ...this };
  delete obj.passwordHash;
  return obj;
};

UserSchema.statics.STATUS = STATUS;

module.exports = mongoose.model('User', UserSchema);
module.exports.ProfileSchema = ProfileSchema;