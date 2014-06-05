"use strict";

var _ = require("lodash");
var utils = require("./utils.js");
var Account = require("./account.js");
var Verification = require("./verification.js");
var FiscalYear = require("./fiscal-year.js");

module.exports = Book;

/**
 * Creates a bookkeeping book that holds verifications on account changes.
 */
function Book() {
    //The accounts of the book are stored as the account number as key.
    this.accounts = {};

    //The array of verifications. Verification number is key.
    this.verifications = {};
    this.numVerifications = 0;

    this.extensions = {};

    this.classifiers = {};

    this.fiscalYears = [];
}

Book.prototype.use = function(extension) {
    if(!_.isObject(extension) || !_.isString(extension.name) || !_.isFunction(extension.apply)) {
        throw new Error("Invalid extension");
    }

    var name = extension.name;

    if(this.extensions[name]) {
        throw new Error("Extension " + name + " already applied to this book.");
    }

    this.extensions[name] = extension;

    extension.apply(this);

    return this;
};

Book.prototype.using = function(name) {
    if(!_.isString(name)) {
        throw new Error("Invalid extension name");
    }

    return !!this.extensions[name];
};

/**
 * Creates a new account and adds it to the book.
 */
Book.prototype.createAccount = function(number, name) {
    if(this.accounts[number]) {
        throw new Error("An account with number " + number + "already exists.");
    }

    var account = new Account(this, number, name);
    this.accounts[number] = account;

    return account;
};

Book.prototype.getAccount = function(number) {
    if(!_.isNumber(number)) {
        throw new Error("Invalid account number.");
    }

    var account = this.accounts[number];

    return account || null;
};

Book.prototype.createVerification = function(date, text) {
    var verification = new Verification(this, utils.parseDate(date), text);

    var key = verification.number;

    if(this.verifications[key]) {
        throw new Error("Internal verification numbering error.");
    }

    this.verifications[key] = verification;
    this.numVerifications++;

    //Let the extensions do their work on the verification before returning it.
    var args = Array.prototype.slice.call(arguments);
    args.splice(0, 2);
    args.unshift(verification);

    _.forEach(this.extensions, function(extension) {
        (extension.createVerification || _.noop).apply(null, args);
    });

    return verification;
};

Book.prototype.getVerification = function(number) {
    return this.verifications[number] || null;
};

Book.prototype.getVerifications = function(from, to) {
    return _.filter(this.verifications, function(v) {
        return utils.insideDates(v.date, from, to);
    });
};

Book.prototype.getNextVerificationNumber = function() {
    return this.numVerifications + 1;
};

Book.prototype.addClassifier = function(type, classifier) {
    if(!_.isString(type)) {
        throw new Error("Invalid type.");
    }

    if(!_.isFunction(classifier)) {
        throw new Error("Classifier function required.");
    }

    if(!_.isArray(this.classifiers[type])) {
        this.classifiers[type] = [];
    }

    this.classifiers[type].push(classifier);
};

Book.prototype.getAccounts = function(type) {
    var result = [];

    var classifiers = this.classifiers[type] || [];

    if(type && !classifiers.length) {
        throw new Error("Invalid classifier type: " + type);
    }

    _.forEach(this.accounts, function(account) {
        var good = true;
        classifiers.forEach(function(classifier) {
            return (good = classifier(account));
        });

        if(good) {
            result.push(account);
        }
    });

    return result;
};

Book.prototype.doctor = function() {
    function unbalancedVerifications(verifications) {
        var unbalanced = _.filter(verifications, function(verification) {
            return !verification.isBalancedCreditDebit();
        });

        return _.map(unbalanced, function(verification) {
            return "Invalid verification: " + verification.number + " is unbalanced.";
        });
    }

    function verificationsOutOfFiscalYears(verifications, fiscalYears) {
        if(!fiscalYears.length) {
            if(_.size(verifications)) {
                return ["Verifications exists without any fiscal years present."];
            }

            return [];
        }

        var start = (_.first(fiscalYears)).from;
        var end = (_.last(fiscalYears)).to;

        var out = _.filter(verifications, function(verification) {
            return verification.date < start || verification.date > end;
        });

        return _.map(out, function(verification) {
            return "Verification out of fiscal years range. Verification: " + verification.number + ". Fiscal year range: " + utils.dateToString(start) + " to " + utils.dateToString(end) + ".";
        });
    }

    var result = [];

    result = result.concat(unbalancedVerifications(this.verifications));
    result = result.concat(verificationsOutOfFiscalYears(this.verifications, this.fiscalYears));

    _.forEach(this.extensions, function(extension) {
        if(extension.doctor) {
            result = result.concat(extension.doctor(this));
        }
    });

    return result;
};

Book.prototype.export = function() {

};

Book.prototype.createFiscalYear = function(from, to) {
    function oneDayDiff(first, second) {
        return (first.getTime() - second.getTime()) / (1000 * 60 * 60 * 24) === 1;
    }

    var fiscalYear = new FiscalYear(this, from, to);

    //Let the extensions do their work on the fiscal year before inserting it.
    var args = Array.prototype.slice.call(arguments);
    args.splice(0, 2);
    args.unshift(fiscalYear);

    _.forEach(this.extensions, function(extension) {
        (extension.createFiscalYear || _.noop).apply(null, args);
    });

    if(!this.fiscalYears.length) {
        this.fiscalYears.push(fiscalYear);
    } else {
        var start = _.first(this.fiscalYears).from;
        var end = _.last(this.fiscalYears).to;

        if(oneDayDiff(start, fiscalYear.to)) {
            this.fiscalYears.unshift(fiscalYear);
        } else if(oneDayDiff(fiscalYear.from, end)) {
            this.fiscalYears.push(fiscalYear);
        } else {
            throw new Error("The fiscal year must be adjacent to the current range.");
        }
    }

    return fiscalYear;
};

/**
 * Returns the fiscal year that matches the selector.
 * @param {number | date | string} selector If date or date string given, the fiscal year that contains the date will be returned. If selector is number it will retrieve the fiscal year at the number position in the fiscal year range (1 is first).
 * @return {FiscalYear | null} Returns the fiscal year that matched to selector. Otherwise null.
 */
Book.prototype.getFiscalYear = function(selector) {
    if(_.isNumber(selector)) {
        return this.fiscalYears[selector - 1] || null;
    }

    var found = null;

    _.forEach(this.fiscalYears, function(fy) {
        if(utils.insideDates(selector, fy.from, fy.to)) {
            found = fy;
            return false;
        }
    });

    return found;
};

Book.prototype.getLastFiscalYear = function() {
    return _.last(this.fiscalYears) || null;
};