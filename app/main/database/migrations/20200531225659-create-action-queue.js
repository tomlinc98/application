module.exports = {
  up: ( queryInterface, Sequelize ) => {
    return queryInterface.createTable( 'ActionQueues', {
      // main fields
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      type: Sequelize.STRING,
      action_date: Sequelize.DATE,
      payload: Sequelize.JSON,

      // timestamps
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
    });
  },
  down: (queryInterface ) => {
    return queryInterface.dropTable( 'ActionQueues' );
  }
};
