/*
 * Copyright 2017-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with
 * the License. A copy of the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

import { AWS, Cognito, ConsoleLogger as Logger, Constants, Hub } from '../Common';

const logger = new Logger('AuthClass');

const {
    CognitoIdentityCredentials
} = AWS;

const {
    CognitoUserPool,
    CognitoUserAttribute,
    CognitoUser,
    AuthenticationDetails
} = Cognito;

const dispatchCredentialsChange = credentials => {
    Hub.dispatch('credentials', credentials, 'Auth');
};

const dispatchAuthEvent = (event, data) => {
    Hub.dispatch('auth', {
        event: event,
        data: data
    }, 'Auth');
};

/**
* Provide authentication functions.
*/
class AuthClass {
    /**
     * @param {Object} config - Configuration of the Auth
     */
    constructor(config) {
        logger.debug('Auth Config', config);
        this.configure(config);

        if (AWS.config) {
            AWS.config.update({ customUserAgent: Constants.userAgent });
        } else {
            logger.warn('No AWS.config');
        }
    }

    /**
     * Configure Auth part with aws configurations
     * @param {Object} config - Configuration of the Auth
     * @return {Object} - Current configuration
     */
    configure(config) {
        logger.debug('configure Auth');
        let conf = config ? config.Auth || config : {};

        if (conf['aws_cognito_identity_pool_id']) {
            conf = {
                userPoolId: config['aws_user_pools_id'],
                userPoolWebClientId: config['aws_user_pools_web_client_id'],
                region: config['aws_cognito_region'],
                identityPoolId: config['aws_cognito_identity_pool_id']
            };
        }

        this._config = Object.assign({}, this._config, conf);

        const { userPoolId, userPoolWebClientId } = this._config;
        if (userPoolId) {
            this.userPool = new CognitoUserPool({
                UserPoolId: userPoolId,
                ClientId: userPoolWebClientId
            });
        }

        return this._config;
    }

    /**
     * Sign up with username, password and other attrbutes like phone, email
     * @param {String | object} params - The user attirbutes used for signin
     * @param {String[]} restOfAttrs - for the backward compatability 
     * @return - A promise resolves callback data if success
     */
    signUp(params, ...restOfAttrs) {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }

        let username = null;
        let password = null;
        const attributes = [];
        let validationData = null;
        if (params && typeof params === 'string') {
            username = params;
            password = restOfAttrs ? restOfAttrs[0] : null;
            const email = restOfAttrs ? restOfAttrs[1] : null;
            const phone_number = restOfAttrs ? restOfAttrs[2] : null;
            if (email) attributes.push({ Name: 'email', Value: email });
            if (phone_number) attributes.push({ Name: 'phone_number', Value: phone_number });
        } else if (params && typeof params === 'object') {
            username = params['username'];
            password = params['password'];
            const attrs = params['attributes'];
            Object.keys(attrs).map(key => {
                const ele = { Name: key, Value: attrs[key] };
                attributes.push(ele);
            });
            validationData = params['validationData'] || null;
        } else {
            return Promise.reject('The first parameter should either be non-null string or object');
        }

        if (!username) {
            return Promise.reject('Username cannot be empty');
        }
        if (!password) {
            return Promise.reject('Password cannot be empty');
        }

        logger.debug('signUp attrs:', attributes);
        logger.debug('signUp validation data:', validationData);

        return new Promise((resolve, reject) => {
            this.userPool.signUp(username, password, attributes, validationData, function (err, data) {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    /**
     * Send the verfication code to confirm sign up
     * @param {String} username - The username to be confirmed
     * @param {String} code - The verification code
     * @return {Promise} - A promise resolves callback data if success
     */
    confirmSignUp(username, code) {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }
        if (!username) {
            return Promise.reject('Username cannot be empty');
        }
        if (!code) {
            return Promise.reject('Code cannot be empty');
        }

        const user = new CognitoUser({
            Username: username,
            Pool: this.userPool
        });
        return new Promise((resolve, reject) => {
            user.confirmRegistration(code, true, function (err, data) {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    /**
     * Resend the verification code
     * @param {String} username - The username to be confirmed
     * @return {Promise} - A promise resolves data if success
     */
    resendSignUp(username) {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }
        if (!username) {
            return Promise.reject('Username cannot be empty');
        }

        const user = new CognitoUser({
            Username: username,
            Pool: this.userPool
        });
        return new Promise((resolve, reject) => {
            user.resendConfirmationCode(function (err, data) {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    /**
     * Sign in
     * @param {String} username - The username to be signed in
     * @param {String} password - The password of the username
     * @return {Promise} - A promise resolves the CognitoUser object if success or mfa required
     */
    signIn(username, password) {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }
        if (!username) {
            return Promise.reject('Username cannot be empty');
        }
        if (!password) {
            return Promise.reject('Password cannot be empty');
        }

        const { userPoolId, userPoolWebClientId } = this._config;
        const pool = new CognitoUserPool({
            UserPoolId: userPoolId,
            ClientId: userPoolWebClientId
        });
        const user = new CognitoUser({
            Username: username,
            Pool: this.userPool
        });
        const authDetails = new AuthenticationDetails({
            Username: username,
            Password: password
        });
        logger.debug(authDetails);
        const _auth = this;
        return new Promise((resolve, reject) => {
            user.authenticateUser(authDetails, {
                onSuccess: session => {
                    _auth.currentCredentials().then(credentials => {
                        const creds = _auth.essentialCredentials(credentials);
                        dispatchCredentialsChange(creds);
                    }).catch(err => logger.error('get credentials failed', err));
                    resolve(user);
                },
                onFailure: err => {
                    logger.error('signIn failure', err);
                    reject(err);
                },
                mfaRequired: (challengeName, challengeParam) => {
                    logger.debug('signIn MFA required');
                    user['challengeName'] = challengeName;
                    user['challengeParam'] = challengeParam;
                    resolve(user);
                },
                newPasswordRequired: (userAttributes, requiredAttributes) => {
                    logger.debug('signIn new password');
                    user['challengeName'] = 'NEW_PASSWORD_REQUIRED';
                    user['challengeParam'] = {
                        userAttributes: userAttributes,
                        requiredAttributes: requiredAttributes
                    };
                    resolve(user);
                }
            });
        });
    }

    /**
     * Send MFA code to confirm sign in
     * @param {Object} user - The CognitoUser object
     * @param {String} code - The confirmation code
     * @return {Promise} - A promise resolves to CognitoUser if success
     */
    confirmSignIn(user, code) {
        if (!code) {
            return Promise.reject('Code cannot be empty');
        }

        const _auth = this;
        return new Promise((resolve, reject) => {
            user.sendMFACode(code, {
                onSuccess: session => {
                    _auth.currentCredentials().then(credentials => {
                        const creds = _auth.essentialCredentials(credentials);
                        dispatchCredentialsChange(creds);
                    }).catch(err => logger.error('get credentials failed', err));
                    resolve(user);
                },
                onFailure: err => {
                    logger.error('confirm signIn failure', err);
                    reject(err);
                }
            });
        });
    }

    completeNewPassword(user, password, requiredAttributes) {
        if (!password) {
            return Promise.reject('Password cannot be empty');
        }

        return new Promise((resolve, reject) => {
            user.completeNewPasswordChallenge(password, requiredAttributes, {
                onSuccess: session => {
                    logger.debug(session);
                    dispatchAuthEvent('signIn', user);
                    resolve(user);
                },
                onFailure: err => {
                    logger.debug('completeNewPassword failure', err);
                    reject(err);
                },
                mfaRequired: (challengeName, challengeParam) => {
                    logger.debug('signIn MFA required');
                    user['challengeName'] = challengeName;
                    user['challengeParam'] = challengeParam;
                    resolve(user);
                }
            });
        });
    }

    /**
     * Update an authenticated users' attributes
     * @param {CognitoUser} - The currently logged in user object
     * @return {Promise} 
     **/
    updateUserAttributes(user, attributes) {
        let attr = {};
        const attributeList = [];
        return this.userSession(user).then(session => {
            return new Promise((resolve, reject) => {
                for (const key in attributes) {
                    if (key !== 'sub' && key.indexOf('_verified') < 0 && attributes[key]) {
                        attr = {
                            'Name': key,
                            'Value': attributes[key]
                        };
                        attributeList.push(attr);
                    }
                }
                user.updateAttributes(attributeList, (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(result);
                    }
                });
            });
        });
    }

    /**
     * Return user attributes
     * @param {Object} user - The CognitoUser object
     * @return {Promise} - A promise resolves to user attributes if success
     */
    userAttributes(user) {
        const _auth = this;
        return this.userSession(user).then(session => {
            return new Promise((resolve, reject) => {
                user.getUserAttributes((err, attributes) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(_auth._attributesToObject(attributes));
                    }
                });
            });
        });
    }

    verifiedContact(user) {
        const that = this;
        return this.userAttributes(user).then(attrs => {
            const verified = {};
            const unverified = {};
            if (attrs.email) {
                if (attrs.email_verified) {
                    verified.email = attrs.email;
                } else {
                    unverified.email = attrs.email;
                }
            }
            if (attrs.phone_number) {
                if (attrs.phone_number_verified) {
                    verified.phone_number = attrs.phone_number;
                } else {
                    unverified.phone_number = attrs.phone_number;
                }
            }
            return { verified: verified, unverified: unverified };
        });
    }

    /**
     * Get current CognitoUser
     * @return {Promise} - A promise resolves to curret CognitoUser if success
     */
    currentUser() {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }

        const user = this.userPool.getCurrentUser();
        return user ? Promise.resolve(user) : Promise.reject('UserPool doesnot have current user');
    }

    /**
     * Get current authenticated user
     * @return {Promise} - A promise resolves to curret authenticated CognitoUser if success
     */
    currentAuthenticatedUser() {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }

        const user = this.userPool.getCurrentUser();
        if (!user) {
            return Promise.reject('No current user');
        }

        return new Promise((resolve, reject) => {
            user.getSession(function (err, session) {
                if (err) {
                    reject(err);
                } else {
                    resolve(user);
                }
            });
        });
    }

    /**
     * Get current user's session
     * @return {Promise} - A promise resolves to session object if success
     */
    currentUserSession() {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }

        const user = this.userPool.getCurrentUser();
        if (!user) {
            return Promise.reject('No current user');
        }
        return this.userSession(user);
    }

    /**
     * Get current user's session
     * @return - A promise resolves to session object if success
     */
    currentSession() {
        return this.currentUserSession();
    }

    /**
     * Get the corresponding user session
     * @param {Object} user - The CognitoUser object
     * @return {Promise} - A promise resolves to the session
     */
    userSession(user) {
        return new Promise((resolve, reject) => {
            user.getSession(function (err, session) {
                if (err) {
                    reject(err);
                } else {
                    resolve(session);
                }
            });
        });
    }

    /**
     * Get authenticated credentials of current user.
     * @return {Promise} - A promise resolves to be current user's credentials
     */
    currentUserCredentials() {
        return this.currentUserSession().then(session => {
            logger.debug('current session', session);
            return new Promise((resolve, reject) => {
                const credentials = this.sessionToCredentials(session);
                credentials.get(err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(credentials);
                    }
                });
            });
        });
    }

    /**
     * Get unauthenticated credentials
     * @return {Promise} - A promise resolves to be a guest credentials
     */
    guestCredentials() {
        const credentials = this.noSessionCredentials();
        return new Promise((resolve, reject) => {
            credentials.get(err => {
                if (err) {
                    reject(err);
                } else {
                    resolve(credentials);
                }
            });
        });
    }

    /**
     * Get current user credentials or guest credentials depend on sign in status.
     * @return {Promise} - A promise resolves to be the current credentials
     */
    currentCredentials() {
        const that = this;
        return this.currentUserCredentials().then(credentials => {
            credentials.authenticated = true;
            return credentials;
        }).catch(err => {
            logger.debug('No current user credentials, load guest credentials');
            return that.guestCredentials().then(credentials => {
                credentials.authenticated = false;
                return credentials;
            });
        });
    }

    /**
     * Initiate an attribute confirmation request
     * @param {Object} user - The CognitoUser
     * @param {Object} attr - The attributes to be verified
     * @return {Promise} - A promise resolves to callback data if success
     */
    verifyUserAttribute(user, attr) {
        return new Promise((resolve, reject) => {
            user.getAttributeVerificationCode(attr, {
                onSuccess: function (data) {
                    resolve(data);
                },
                onFailure: function (err) {
                    reject(err);
                }
            });
        });
    }

    /**
     * Confirm an attribute using a confirmation code
     * @param {Object} user - The CognitoUser
     * @param {Object} attr - The attribute to be verified
     * @param {String} code - The confirmation code
     * @return {Promise} - A promise resolves to callback data if success
     */
    verifyUserAttributeSubmit(user, attr, code) {
        return new Promise((resolve, reject) => {
            user.verifyAttribute(attr, code, {
                onSuccess: function (data) {
                    resolve(data);
                },
                onFailure: function (err) {
                    reject(err);
                }
            });
        });
    }

    /**
     * Sign out method
     * @return {Promise} - A promise resolved if success
     */
    signOut() {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }

        const user = this.userPool.getCurrentUser();
        if (!user) {
            return Promise.resolve();
        }

        const _auth = this;
        return new Promise((resolve, reject) => {
            user.signOut();
            _auth.currentCredentials().then(credentials => dispatchCredentialsChange(credentials)).catch(err => logger.error('get credentials failed', err));
            resolve();
        });
    }

    /**
     * Initiate a forgot password request
     * @param {String} username - the username to change password
     * @return {Promise} - A promise resolves if success
     */
    forgotPassword(username) {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }
        if (!username) {
            return Promise.reject('Username cannot be empty');
        }

        const user = new CognitoUser({
            Username: username,
            Pool: this.userPool
        });
        return new Promise((resolve, reject) => {
            user.forgotPassword({
                onSuccess: () => {
                    resolve();
                },
                onFailure: err => {
                    logger.error(err);
                    reject(err);
                },
                inputVerificationCode: data => {
                    resolve(data);
                }
            });
        });
    }

    /**
     * Confirm a new password using a confirmation Code
     * @param {String} username - The username
     * @param {String} code - The confirmation code
     * @param {String} password - The new password
     * @return {Promise} - A promise that resolves if success
     */
    forgotPasswordSubmit(username, code, password) {
        if (!this.userPool) {
            return Promise.reject('No userPool');
        }
        if (!username) {
            return Promise.reject('Username cannot be empty');
        }
        if (!code) {
            return Promise.reject('Code cannot be empty');
        }
        if (!password) {
            return Promise.reject('Password cannot be empty');
        }

        const user = new CognitoUser({
            Username: username,
            Pool: this.userPool
        });
        return new Promise((resolve, reject) => {
            user.confirmPassword(code, password, {
                onSuccess: () => {
                    resolve();
                },
                onFailure: err => {
                    reject(err);
                }
            });
        });
    }

    /**
     * Initiate an attribute confirmation request for the current user
     * @param {String} attr - The attributes to be verified
     * @return {Promise} - A promise resolves to callback data if success
     */
    verifyCurrentUserAttribute(attr) {
        const _auth = this;
        return _auth.currentAuthenticatedUser().then(user => _auth.verifyUserAttribute(user, attr));
    }

    /**
     * Confirm current user's attribute using a confirmation code
     * @param {String} attr - The attribute to be verified
     * @param {String} code - The confirmation code
     * @return {Promise} - A promise resolves to callback data if success
     */
    verifyCurrentUserAttributeSubmit(attr, code) {
        if (!code) {
            return Promise.reject('Code cannot be empty');
        }

        const _auth = this;
        return _auth.currentAuthenticatedUser().then(user => _auth.verifyUserAttributeSubmit(user, attr, code));
    }

    /**
     * Get user information
     * @async
     * @return {Object }- current User's information
     */
    async currentUserInfo() {
        const user = await this.currentAuthenticatedUser().catch(err => logger.debug(err));
        if (!user) {
            return null;
        }

        const [attributes, credentials] = await Promise.all([this.userAttributes(user), this.currentUserCredentials()]).catch(err => {
            logger.debug('currentUserInfo error', err);
            return [{}, {}];
        });

        const info = {
            username: user.username,
            id: credentials.identityId,
            attributes
        };
        logger.debug('user info', info);
        return info;
    }

    /**
     * @return {Object} - A new guest CognitoIdentityCredentials
     */
    noSessionCredentials() {
        const credentials = new CognitoIdentityCredentials({
            IdentityPoolId: this._config.identityPoolId
        }, {
            region: this._config.region
        });

        credentials.params.IdentityId = null; // Cognito load IdentityId from local cache
        return credentials;
    }

    /**
     * Produce a credentials based on the session
     * @param {Object} session - The session used to generate the credentials
     * @return {Object} - A new CognitoIdentityCredentials
     */
    sessionToCredentials(session) {
        const idToken = session.getIdToken().getJwtToken();
        const { region, userPoolId, identityPoolId } = this._config;
        const key = 'cognito-idp.' + region + '.amazonaws.com/' + userPoolId;
        let logins = {};
        logins[key] = idToken;
        return new CognitoIdentityCredentials({
            IdentityPoolId: identityPoolId,
            Logins: logins
        }, {
            region: this._config.region
        });
    }

    /**
     * Compact version of credentials
     * @param {Object} credentials
     * @return {Object} - Credentials
     */
    essentialCredentials(credentials) {
        return {
            accessKeyId: credentials.accessKeyId,
            sessionToken: credentials.sessionToken,
            secretAccessKey: credentials.secretAccessKey,
            identityId: credentials.identityId,
            authenticated: credentials.authenticated
        };
    }

    /**
     * @private
     */
    _attributesToObject(attributes) {
        const obj = {};
        if (attributes) {
            attributes.map(attribute => {
                if (attribute.Name === 'sub') return;

                if (attribute.Value === 'true') {
                    obj[attribute.Name] = true;
                } else if (attribute.Value === 'false') {
                    obj[attribute.Name] = false;
                } else {
                    obj[attribute.Name] = attribute.Value;
                }
            });
        }
        return obj;
    }
}

export default AuthClass;