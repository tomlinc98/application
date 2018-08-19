import { Model, DataTypes } from 'sequelize';

module.exports = class Continent extends Model {
  static FIELDS = {
    code: {
      type: DataTypes.STRING( 2 ),
      allowNull: false,
      unique: true
    },
    name: {
      type: DataTypes.STRING( 64 ),
      allowNull: false,
      unique: true
    }
  }

  static OPTIONS = {
    timestamps: false
  }

  static init( sequelize ) {
    return super.init( Continent.FIELDS, {
      ...Continent.OPTIONS,
      sequelize
    });
  }

  static associate( models ) {
    this.hasMany( models.Country );
  }
};