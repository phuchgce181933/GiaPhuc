'use strict';

const mongoose = require('mongoose');
const { PERMISSION_LIST } = require('../../shared/permissions');

/**
 * Role document. A role holds a list of permission keys (strings).
 * System roles (admin, user) cannot be deleted or have their key changed.
 */
const RoleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.every((p) => PERMISSION_LIST.includes(p));
        },
        message: 'Unknown permission key in role.permissions',
      },
    },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);

RoleSchema.index({ name: 1 }, { unique: false });

module.exports = mongoose.model('Role', RoleSchema);